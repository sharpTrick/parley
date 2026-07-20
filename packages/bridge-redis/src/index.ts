import {
  asBackendMsgId,
  asCursor,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  buildMessage,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import { delay } from '@sharptrick/parley-net-util';
import { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

/** Plugin-specific backend_config. */
export interface RedisBackendConfig {
  /** Connection URL. Default `redis://127.0.0.1:6379`. */
  url?: string;
  /** Stream key prefix. Default `parley:`. One Redis Stream per topic: `<prefix><topic>`. */
  key_prefix?: string;
  /** XREAD BLOCK timeout (ms) — the loop re-checks for shutdown each interval. Default 2000. */
  block_ms?: number;
  /**
   * Optional retention window in days: entries older than this are (approximately) trimmed on
   * every `post` via `XADD`'s own `MINID` trim option — no separate job or connection. Omit for
   * the default — keep every entry forever. A topic with no new posts isn't trimmed until its
   * next post (trimming is opportunistic, tied to write activity, not a background timer).
   */
  retention_days?: number;
}

/**
 * Redis Streams backend (DESIGN §6/§9) — the FIRST event-driven push backend. A Stream entry id
 * (`XADD *`, e.g. `1700-0`) is monotonic per stream and serves as BOTH `backendMsgId` (dedup key)
 * and `cursor` (order key). `fetchRecent` = `XRANGE` (exclusive `(since`); `subscribe` = an
 * `XREAD BLOCK` loop on a dedicated connection driven by REAL events, not a poll timer. Stream ids
 * are not lexically comparable, but core never compares cursors — Redis returns entries in order.
 */
export class RedisPlugin implements BackendPlugin {
  private client?: RedisClient;
  private prefix = 'parley:';
  private blockMs = 2000;
  private retentionDays?: number;
  /**
   * Per-connect generation token. Bumped on every `connect()`/`disconnect()`; each `subscribe()`
   * captures the current value and gates its read loop on `gen === this.generation`. Because it
   * only ever increases, a torn-down (or superseded) loop can never be revived by a later
   * `connect()` — unlike a shared mutable boolean that a reconnect could reset (BUG-37).
   */
  private generation = 0;
  private readonly readers: RedisClient[] = [];

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as RedisBackendConfig;
    this.prefix = cfg.key_prefix ?? 'parley:';
    this.blockMs = cfg.block_ms ?? 2000;
    this.retentionDays = cfg.retention_days;
    this.generation++; // re-baseline the generation so a fresh connect can't revive a prior loop
    const client = createClient({ url: cfg.url ?? 'redis://127.0.0.1:6379' });
    client.on('error', () => {
      /* transient connection errors surface via command rejections; don't crash the process */
    });
    await client.connect();
    this.client = client;
  }

  async disconnect(): Promise<void> {
    this.generation++; // supersede every in-flight/straggler subscribe loop so they exit deterministically
    for (const reader of this.readers.splice(0)) {
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
    const id = await this.require().xAdd(
      this.key(topic),
      '*',
      {
        sender: identity,
        content,
        ts: new Date().toISOString(),
        in_reply_to: opts?.inReplyTo ?? '',
      },
      this.retentionDays !== undefined
        ? {
            TRIM: {
              strategy: 'MINID',
              strategyModifier: '~',
              threshold: Date.now() - this.retentionDays * 86_400_000,
            },
          }
        : undefined,
    );
    return asBackendMsgId(id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const key = this.key(args.topic);
    const limit = args.limit ?? 100;
    let entries: Array<{ id: string; message: Record<string, string> }>;
    if (args.since === undefined) {
      // Default window: the most recent `limit` entries, returned ascending by cursor.
      entries = (await this.require().xRevRange(key, '+', '-', { COUNT: limit })).reverse();
    } else {
      // Exclusive: strictly after `since`, ascending. `(` makes XRANGE start exclusive.
      entries = await this.require().xRange(key, `(${args.since}`, '+', { COUNT: limit });
      // Native long-poll (issue #20): the canonical XRANGE was empty and the caller granted a
      // budget → wait up to `blockMs` for entries strictly after `since`. XREAD BLOCK is itself
      // the bounded wait, and a Stream entry id IS the cursor, so `XREAD ... STREAMS key <since>`
      // returns exactly the entries a repeated exclusive XRANGE would — same {id, message} shape,
      // same ascending order — mapped identically below. No waiter map, no re-run of XRANGE.
      // Gate on the FLOORED budget: `blockMs` is typed `number`, so a sub-ms hint (e.g. 0.5)
      // passes `> 0` yet floors to 0 — and `XREAD BLOCK 0` blocks FOREVER. Flooring first makes
      // such budgets correctly degrade to "return immediately, empty" (core polls the remainder).
      const block = Math.floor(args.blockMs ?? 0);
      if (entries.length === 0 && block > 0) {
        entries = await this.blockingRead(key, args.since, block, limit);
      }
    }
    const messages = entries.map((e) => rowToMessage(args.topic, e.id, e.message));
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : (args.since ?? asCursor('0-0'));
    return { messages, nextCursor };
  }

  /**
   * Bounded blocking wait for entries strictly after `since`, on a DEDICATED reader connection.
   * A dedicated connection is mandatory, not an optimization: `XREAD BLOCK` holds its connection
   * for the whole wait, so running it on the shared command client would stall every concurrent
   * `post` (XADD) — including a post racing in on the SAME plugin instance that is meant to wake
   * this very wait — turning the long-poll into a deadlock.
   *
   * The reader is registered in `this.readers` BEFORE the blocking call so a concurrent
   * `disconnect()` finds and tears it down (breaking the blocking read), and the loop is gated on
   * the connect generation so a disconnect/reconnect racing this window can never revive it. On
   * any early exit — timeout, teardown, or error — we return `[]`, which is always safe: the empty
   * page carries `nextCursor === since` and core polls the remaining budget on the MCP path.
   */
  private async blockingRead(
    key: string,
    since: string,
    blockMs: number,
    limit: number,
  ): Promise<Array<{ id: string; message: Record<string, string> }>> {
    // Defensive floor: `XREAD BLOCK 0` blocks FOREVER, so a non-positive budget must never reach
    // Redis regardless of caller. The XRANGE path already returned the immediate answer ([]).
    if (blockMs <= 0) return [];
    const gen = this.generation;
    const reader = this.require().duplicate();
    reader.on('error', () => undefined);
    // Register BEFORE connecting so a disconnect() racing this window can always find and close the
    // reader (mirrors the subscribe() pattern); registering after connect leaks a fresh duplicate.
    this.readers.push(reader);
    try {
      await reader.connect();
      if (gen !== this.generation) return []; // disconnect() won the race during connect()
      // `id: since` (a concrete cursor, not '$') means XREAD returns everything strictly after
      // `since` — including an entry that landed in the XRANGE→XREAD gap — with no missed-message
      // window. Waits at most `blockMs`; a wake returns immediately, a timeout returns null.
      const res = await reader.xRead({ key, id: since }, { BLOCK: blockMs, COUNT: limit });
      if (gen !== this.generation || res === null) return [];
      return res[0]?.messages ?? [];
    } catch {
      // Timeout is null (handled above); a throw here is teardown or a transient socket drop.
      // Returning [] is safe (core polls the remainder) and never masks a real fault — the
      // canonical XRANGE above already succeeded against the live connection.
      return [];
    } finally {
      this.dropReader(reader);
      await reader.disconnect().catch(() => undefined);
    }
  }

  /**
   * Live path = an `XREAD BLOCK` loop on a dedicated connection (DESIGN §9 — genuine events, not a
   * poll timer). Starts at `$` (new entries only; history is owned by catch-up). `disconnect()`
   * tears the reader down, which breaks the blocking read.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    // Capture the generation this subscribe belongs to; every continuation below is gated on it
    // still being current, so a disconnect()/reconnect that ran meanwhile tears this loop down.
    const gen = this.generation;
    const reader = this.require().duplicate();
    reader.on('error', () => undefined);
    // Register BEFORE connecting so a disconnect() racing this window can always find and close
    // the reader (BUG-37); registering after connect leaks a freshly-connected duplicate.
    this.readers.push(reader);
    try {
      await reader.connect();
    } catch (err) {
      this.dropReader(reader);
      await reader.disconnect().catch(() => undefined);
      throw err;
    }
    if (gen !== this.generation) {
      // disconnect() won the race during connect() → tear the reader down instead of leaking it,
      // and start no loop for this superseded connection.
      this.dropReader(reader);
      await reader.disconnect().catch(() => undefined);
      return;
    }
    const key = this.key(topic);

    // Capture the stream tail *before* subscribe() resolves, so a post() (XADD) racing in right
    // after can't be missed. Starting the read loop at '$' is unsafe: '$' only resolves to "the
    // last id" when the first blocking XREAD actually registers server-side, and subscribe()
    // returns without awaiting that read (`void loop()` below). A message added in that window
    // gets an id below the resolved '$' and is dropped forever. A concrete id has no such gap —
    // XREAD returns everything strictly after it, including messages added during startup.
    let lastId = '0';
    try {
      lastId = (await reader.xInfoStream(key)).lastGeneratedId;
    } catch (err) {
      if (gen !== this.generation) {
        // disconnect() raced in during the probe; it already tore the registered reader down.
        this.dropReader(reader);
        await reader.disconnect().catch(() => undefined);
        return;
      }
      // Only a genuinely missing stream means "no history to skip" (node-redis surfaces
      // `ERR no such key` for XINFO STREAM on a non-existent key). Any OTHER failure (socket drop,
      // LOADING during a restart, READONLY after failover, NOPERM on XINFO) must NOT be seeded as
      // '0' — that would XREAD from the start and replay the whole retained history as live
      // <channel> push (BUG-11). Surface it so core observes the failure instead of flooding.
      if (!/no such key/i.test(String((err as Error)?.message ?? err))) {
        this.dropReader(reader);
        await reader.disconnect().catch(() => undefined);
        throw err;
      }
      // stream doesn't exist yet → '0' delivers everything from here on
    }

    const loop = async (): Promise<void> => {
      while (gen === this.generation) {
        let res:
          | Array<{ name: string; messages: Array<{ id: string; message: Record<string, string> }> }>
          | null;
        try {
          res = await reader.xRead({ key, id: lastId }, { BLOCK: this.blockMs, COUNT: 256 });
        } catch {
          if (gen !== this.generation) break; // torn down/superseded → exit, never spin-retry (BUG-37)
          await delay(100);
          continue;
        }
        if (gen !== this.generation) break;
        if (res === null) continue; // BLOCK timed out with no new entries
        for (const stream of res) {
          for (const entry of stream.messages) {
            lastId = entry.id;
            try {
              handler(rowToMessage(topic, entry.id, entry.message));
            } catch {
              /* handler is best-effort; never break the loop (DESIGN §6) */
            }
          }
        }
      }
    };
    void loop();
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }

  private key(topic: Topic): string {
    return `${this.prefix}${topic}`;
  }

  /** Remove a specific reader from the registry (used when a subscribe tears its own reader down). */
  private dropReader(reader: RedisClient): void {
    const i = this.readers.indexOf(reader);
    if (i !== -1) this.readers.splice(i, 1);
  }

  private require(): RedisClient {
    if (this.client === undefined) {
      throw new Error('RedisPlugin not connected — call connect() first');
    }
    return this.client;
  }
}

function rowToMessage(topic: Topic, id: string, fields: Record<string, string>): Message {
  return buildMessage({
    topic,
    sender: fields.sender ?? '',
    content: fields.content ?? '',
    timestamp: fields.ts ?? '',
    id,
  });
}
