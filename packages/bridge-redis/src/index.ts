import {
  asBackendMsgId,
  asCursor,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import {
  createRedisClient,
  openCommandClient,
  type RedisClient,
  serverRefusal,
  unreachable,
  withDeadline,
} from './client.js';
import { type RedisBackendConfig, resolveConfig, type ResolvedConfig } from './config.js';
import { errorText, fromServer } from './diagnostics.js';
import { type Entry, rowToMessage } from './entry.js';
import { assertMintedCursor, compareIds, MAX_ENTRY_ID, streamTail } from './entry-id.js';
import { runReadLoop } from './read-loop.js';

export { createRedisClient } from './client.js';
export { CONFIG_KEYS, DEFAULT_URL, type RedisBackendConfig } from './config.js';

/**
 * How many long-polling `fetchRecent` calls may hold a dedicated reader connection at once. Keep
 * the cap, so that concurrent long-polls cannot exhaust the `maxclients` of a Redis every peer
 * session shares: `XREAD BLOCK` holds its connection for the whole wait, and core neither limits
 * `fetch_recent` concurrency nor cancels an abandoned one. `subscribe` readers are deliberately NOT
 * counted: those are one per subscribed topic, bounded by the config.
 */
export const MAX_BLOCKING_READERS = 8;

/**
 * Redis Streams backend (DESIGN §6/§9) — the FIRST event-driven push backend. A Stream entry id
 * (`XADD *`, e.g. `1700-0`) is monotonic per stream and serves as BOTH `backendMsgId` (dedup key)
 * and `cursor` (order key). `fetchRecent` = `XRANGE` (exclusive `(since`, except that a `since`
 * past the stream's last generated id is treated as unset and replays the recent window, so
 * catch-up self-heals); `subscribe` = an `XREAD BLOCK` loop on a dedicated connection driven by
 * REAL events, not a poll timer. Stream ids are not lexically comparable, but core never compares
 * cursors.
 */
export class RedisPlugin implements BackendPlugin {
  private client?: RedisClient;
  private cfg: ResolvedConfig = resolveConfig({});
  /**
   * Per-connect generation token. Bumped on every `connect()`/`disconnect()`; each reader captures
   * it and gates its continuations on `gen === this.generation`. Because it only ever increases, a
   * superseded loop can never be revived by a later `connect()`, unlike a boolean a reconnect
   * resets.
   */
  private generation = 0;
  private readonly readers: RedisClient[] = [];
  /**
   * Readers whose `connect()` has not settled yet. Keep the exclusion in `tearDown`, so that a
   * reader is never disconnected mid-handshake: node-redis assigns its socket only once the TCP
   * connect resolves, so a `disconnect()` before that flips the client to closed WITHOUT a socket
   * to destroy, the handshake then completes onto a live socket, and every later `disconnect()`
   * throws `ClientClosedError` — an orphan nothing can close. Whoever awaits the connect closes it
   * instead.
   */
  private readonly connecting = new Set<RedisClient>();
  private blockingReaders = 0;
  /**
   * Serializes `connect`/`disconnect`. Keep it, so that two overlapping lifecycle calls cannot both
   * open a command client: each reads `this.client` before the other assigns it, and the loser's
   * socket is then referenced by nothing and can never be closed — a leak that also holds the event
   * loop open at shutdown.
   */
  private lifecycle: Promise<unknown> = Promise.resolve();

  async connect(config: BackendConfig): Promise<void> {
    return this.serialize(() => this.open(config as RedisBackendConfig));
  }

  async disconnect(): Promise<void> {
    return this.serialize(() => this.tearDown());
  }

  /**
   * Keep every backend refusal labelled, so that a repurposed key or a revoked ACL reaches the
   * operator naming the plugin, the topic and the Redis key rather than as a bare RESP line
   * (`WRONGTYPE Operation against a key holding the wrong kind of value`) that names none of them.
   */
  private async labelled<T>(topic: Topic, key: string, work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('parley-redis:')) throw err;
      const text = fromServer(this.cfg.url, errorText(err));
      throw new Error(`parley-redis: ${text} (topic '${topic}', key '${key}')`);
    }
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lifecycle.then(work, work); // whichever way the previous call settled
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  private async open(cfg: RedisBackendConfig): Promise<void> {
    const resolved = resolveConfig(cfg);
    // Tear the previous connection down first, so that a re-connect cannot orphan a live socket per
    // call until Redis hits maxclients. It also re-baselines the generation, killing prior loops.
    await this.tearDown();
    this.cfg = resolved;
    this.client = await openCommandClient(resolved.url, resolved.connectTimeoutMs);
  }

  private async tearDown(): Promise<void> {
    this.generation++;
    for (const reader of this.readers.splice(0)) {
      if (this.connecting.has(reader)) continue;
      await reader.disconnect().catch(() => undefined);
    }
    if (this.client !== undefined) {
      await this.client.disconnect().catch(() => undefined);
      this.client = undefined;
    }
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const key = this.key(topic);
    const { retentionDays } = this.cfg;
    const id = await this.labelled(topic, key, () =>
      this.require().xAdd(
        key,
        '*',
        {
          sender: identity,
          content,
          ts: new Date().toISOString(),
          in_reply_to: opts?.inReplyTo ?? '',
        },
        retentionDays !== undefined
          ? {
              TRIM: {
                strategy: 'MINID',
                strategyModifier: '~',
                // Keep the floor, so that a window whose millisecond product is not whole (30/7,
                // 1e-6 — both accepted by the validator) cannot reach Redis as a fractional stream
                // id and make EVERY post fail against a `connect()` that already resolved.
                threshold: Math.floor(Date.now() - retentionDays * 86_400_000),
              },
            }
          : undefined,
      ),
    );
    return asBackendMsgId(id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const key = this.key(args.topic);
    return this.labelled(args.topic, key, () => this.readWindow(args, key));
  }

  private async readWindow(args: FetchRecentArgs, key: string): Promise<FetchRecentResult> {
    const limit = args.limit ?? 100;
    if (args.since !== undefined) assertMintedCursor(args.topic, args.since);
    let since: string | undefined = args.since;
    let entries: Entry[];
    if (since === undefined) {
      entries = (await this.require().xRevRange(key, '+', '-', { COUNT: limit })).reverse();
    } else {
      // `(` makes XRANGE start exclusive. Keep the ceiling out of it, so that a cursor at the top
      // of the id space still reaches the heal below: `(<max>-<max>` is refused outright (`ERR
      // invalid start ID for the interval`), which would wedge the topic — the one thing the heal
      // exists to prevent. Keep the comparison NUMERIC, so that another spelling of that id
      // (`018446744073709551615-…`, well-formed to the validator) cannot slip past and reach it.
      entries =
        compareIds(since, MAX_ENTRY_ID) >= 0
          ? []
          : await this.require().xRange(key, `(${since}`, '+', { COUNT: limit });
      // A cursor sorting past the stream's last generated id was minted against a different Redis,
      // a re-created dataset or a skewed clock; it is treated exactly like `since === undefined`,
      // for both the query AND the returned cursor, so that on-start catch-up SELF-HEALS. Echoing
      // the dead cursor back instead wedges this topic forever: every later fetch returns the same
      // empty page, with no error to retry and nothing to tell it from "nothing new". Checked only
      // once XRANGE came back empty.
      if (entries.length === 0 && compareIds(since, await streamTail(this.require(), key)) > 0) {
        since = undefined;
        entries = (await this.require().xRevRange(key, '+', '-', { COUNT: limit })).reverse();
      }
    }
    if (since !== undefined && entries.length === 0) {
      // Native long-poll: the XRANGE was empty and the caller granted a budget → wait up to
      // `blockMs` for entries strictly after `since`. A Stream entry id IS the cursor, so XREAD
      // returns exactly the entries a repeated exclusive XRANGE would. Gate on the FLOORED budget:
      // a sub-ms hint (0.5) passes `> 0` yet floors to 0, and `XREAD BLOCK 0` blocks FOREVER.
      const block = Math.floor(args.blockMs ?? 0);
      if (block > 0) {
        entries = await this.blockingRead(key, since, block, limit);
      }
    }
    const messages = entries.map((e) => rowToMessage(args.topic, e.id, e.message));
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : asCursor(since ?? '0-0');
    return { messages, nextCursor };
  }

  /**
   * Bounded blocking wait for entries strictly after `since`, on a DEDICATED reader connection. The
   * dedicated connection is mandatory, not an optimization: `XREAD BLOCK` holds its connection for
   * the whole wait, so running it on the shared command client would stall every concurrent `post`
   * (XADD) — including the post meant to wake this very wait — into a deadlock. A timeout, a
   * teardown, a transient fault or a call past {@link MAX_BLOCKING_READERS} returns `[]`, which is
   * safe: the empty page carries `nextCursor === since` and core polls the rest of the budget.
   */
  private async blockingRead(
    key: string,
    since: string,
    blockMs: number,
    limit: number,
  ): Promise<Entry[]> {
    if (this.blockingReaders >= MAX_BLOCKING_READERS) return [];
    const gen = this.generation;
    const reader = this.newReader();
    this.blockingReaders++;
    try {
      await this.connectReader(reader);
      if (gen !== this.generation) return [];
      // `id: since` (a concrete cursor, not '$') means XREAD returns everything strictly after
      // `since`, including an entry that landed in the XRANGE→XREAD gap.
      const res = await reader.xRead({ key, id: since }, { BLOCK: blockMs, COUNT: limit });
      if (gen !== this.generation || res === null) return [];
      return res[0]?.messages ?? [];
    } catch (err) {
      // Keep the refusal rethrow, so that a NOPERM/WRONGTYPE ending the long poll is not silent
      // while `subscribe` reports the identical fault: core answers an empty page by napping and
      // retrying, so a swallowed refusal burns the whole budget opening doomed readers.
      if (gen === this.generation && serverRefusal(err) !== undefined) throw err;
      return [];
    } finally {
      this.blockingReaders--;
      await this.retireReader(reader);
    }
  }

  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    return this.labelled(topic, this.key(topic), () => this.startReadLoop(topic, handler));
  }

  private async startReadLoop(topic: Topic, handler: MessageHandler): Promise<void> {
    const gen = this.generation;
    const reader = this.newReader();
    try {
      await this.connectReader(reader);
    } catch (err) {
      await this.retireReader(reader);
      throw err;
    }
    if (gen !== this.generation) {
      await this.retireReader(reader); // disconnect() won the race; start no loop for it
      return;
    }
    const key = this.key(topic);

    // Capture the stream tail *before* subscribe() resolves, so a post() (XADD) racing in right
    // after can't be missed. '$' is unsafe: it only resolves to "the last id" when the first
    // blocking XREAD registers server-side, and subscribe() returns without awaiting that read, so
    // a message added in that window gets an id below it and is dropped forever.
    let from: string;
    try {
      from = await streamTail(reader, key);
    } catch (err) {
      await this.retireReader(reader);
      // A disconnect() racing the probe leaves a superseded subscription, not a fault to surface.
      if (gen !== this.generation) return;
      throw err;
    }

    const { url, blockMs } = this.cfg;
    void runReadLoop(
      {
        reader,
        topic,
        key,
        url,
        blockMs,
        from,
        isCurrent: () => gen === this.generation,
        retire: () => this.retireReader(reader),
      },
      handler,
    );
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }

  private key(topic: Topic): string {
    return `${this.cfg.prefix}${topic}`;
  }

  /**
   * A registered but not yet connected reader. Built from the same fail-fast options as the command
   * client rather than `duplicate()`d from it, so that a reader opened while Redis is unreachable
   * rejects instead of retrying forever and hanging `subscribe()`. Registered BEFORE the handshake,
   * so that a `disconnect()` racing this window finds and closes it.
   */
  private newReader(): RedisClient {
    this.require();
    const reader = createRedisClient(this.cfg.url, this.cfg.connectTimeoutMs);
    this.readers.push(reader);
    return reader;
  }

  private async connectReader(reader: RedisClient): Promise<void> {
    const { url, connectTimeoutMs } = this.cfg;
    this.connecting.add(reader);
    try {
      await withDeadline(reader.connect(), connectTimeoutMs, unreachable(url, connectTimeoutMs));
    } finally {
      this.connecting.delete(reader);
    }
  }

  private async retireReader(reader: RedisClient): Promise<void> {
    const i = this.readers.indexOf(reader);
    if (i !== -1) this.readers.splice(i, 1);
    await reader.disconnect().catch(() => undefined);
  }

  private require(): RedisClient {
    if (this.client === undefined) {
      throw new Error('RedisPlugin not connected — call connect() first');
    }
    return this.client;
  }
}
