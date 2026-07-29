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
import { createClient } from 'redis';

type RedisClient = ReturnType<typeof createClient>;

const DEFAULT_URL = 'redis://127.0.0.1:6379';
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
/** A Redis Stream entry id — `<ms>` or `<ms>-<seq>`. Cursors and backendMsgIds are exactly this. */
const CURSOR_PATTERN = /^\d+(-\d+)?$/;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Plugin-specific backend_config. */
export interface RedisBackendConfig {
  /** Connection URL. Default `redis://127.0.0.1:6379`. */
  url?: string;
  /** Stream key prefix. Default `parley:`. One Redis Stream per topic: `<prefix><topic>`. */
  key_prefix?: string;
  /** XREAD BLOCK timeout (ms) — the loop re-checks for shutdown each interval. Default 2000. */
  block_ms?: number;
  /** How long the FIRST handshake may take before `connect()` rejects (ms). Default 5000. */
  connect_timeout_ms?: number;
  /**
   * Optional retention window in days: entries older than this are (approximately) trimmed on
   * every `post` via `XADD`'s own `MINID` trim option — no separate job or connection. Omit (or
   * `null`) for the default — keep every entry forever; there is no "trim everything" mode. A
   * topic with no new posts isn't trimmed until its next post (trimming is opportunistic, tied to
   * write activity, not a background timer).
   */
  retention_days?: number | null;
}

/**
 * The connection every parley-redis socket is built from — the command client, the
 * `subscribe`/long-poll readers, and any test probe. Exported so a harness cannot be configured
 * more defensively than the code under test.
 *
 * Keep the pre-`ready` `Error` return, so that `connect()` REJECTS against an unreachable or wrong
 * endpoint; node-redis' default strategy retries forever and leaves `connect()` pending for the
 * life of the process. After the first handshake the same strategy switches to bounded backoff, so
 * a connection that was live still rides out an outage.
 *
 * Keep `disableOfflineQueue`, so that commands issued while disconnected REJECT instead of being
 * queued for the length of the outage — a `parley_post` tool call must fail, not hang unbounded.
 */
export function createRedisClient(url: string, connectTimeoutMs: number): RedisClient {
  let handshakeComplete = false;
  const client = createClient({
    url,
    disableOfflineQueue: true,
    socket: {
      connectTimeout: connectTimeoutMs,
      reconnectStrategy: (retries: number) =>
        handshakeComplete
          ? Math.min(50 * 2 ** retries, 2000)
          : new Error(unreachable(url, connectTimeoutMs)),
    },
  });
  client.on('ready', () => {
    handshakeComplete = true;
  });
  client.on('error', () => {
    /* the offline queue is disabled, so faults surface as command rejections; don't crash */
  });
  return client;
}

/**
 * The one message every failed-to-come-up path reports, so which watchdog fired first — the
 * socket's `connectTimeout`, the reconnect strategy, or the whole-handshake deadline — is not
 * observable to a caller who only needs to know the endpoint is unusable.
 */
function unreachable(url: string, connectTimeoutMs: number): string {
  return `parley-redis: cannot reach ${endpointOf(url)} (connect_timeout_ms=${connectTimeoutMs})`;
}

/**
 * Bound a handshake END TO END, so that an endpoint which completes the TCP connection and then
 * never speaks Redis (a hung server, a load balancer in front of a dead backend, a non-Redis port)
 * cannot leave the bridge pending forever: node-redis' `connectTimeout` covers socket
 * establishment only, so the protocol handshake after it has no watchdog of its own.
 */
async function withDeadline<T>(work: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
      }),
    ]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** `host:port` of a connection URL — never the password, which must not reach a log line. */
function endpointOf(url: string): string {
  try {
    const u = new URL(url);
    return `${u.hostname}:${u.port === '' ? '6379' : u.port}`;
  } catch {
    return '<unparseable url>';
  }
}

/**
 * `retention_days` is multiplied into a destructive `XADD MINID` threshold, so every unusable
 * value must be rejected at `connect()` rather than coerced: `0`/negative silently delete history
 * (or every entry, forever, as it lands), a value past the epoch makes the threshold negative so
 * every `post` throws, and a string/NaN produces an invalid stream id. `null` means "omitted",
 * matching how DESIGN §11 spells an unset config value.
 */
function normalizeRetentionDays(value: number | null | undefined): number | undefined {
  if (value === undefined || value === null) return undefined;
  const maxDays = Math.floor(Date.now() / 86_400_000);
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0 || value > maxDays) {
    throw new Error(
      `parley-redis: retention_days must be a positive number of days no greater than ${maxDays} ` +
        `(got ${JSON.stringify(value)}); omit it (or set null) to keep every entry forever`,
    );
  }
  return value;
}

/**
 * The last id a stream generated, or `'0'` when the stream does not exist.
 *
 * Keep the `EXISTS` probes, so that "no history yet" is decided by server STATE and never by
 * matching `XINFO STREAM`'s `ERR no such key` wording: a Redis-compatible server, proxy or future
 * release that words it differently would turn an empty stream into a hard failure, and any
 * unrelated error whose text happens to contain that phrase would turn a real fault into a
 * from-the-beginning replay of the whole retained history as live push (BUG-11).
 */
async function streamTail(client: RedisClient, key: string): Promise<string> {
  if ((await client.exists(key)) === 0) return '0';
  try {
    return (await client.xInfoStream(key)).lastGeneratedId;
  } catch (err) {
    if ((await client.exists(key)) === 0) return '0'; // deleted in the EXISTS → XINFO gap
    throw err;
  }
}

/** Order two stream ids; a bare `<ms>` cursor has an implicit sequence of 0, as Redis reads it. */
function compareIds(a: string, b: string): number {
  const [aMs = '0', aSeq = '0'] = a.split('-');
  const [bMs = '0', bSeq = '0'] = b.split('-');
  if (BigInt(aMs) !== BigInt(bMs)) return BigInt(aMs) < BigInt(bMs) ? -1 : 1;
  if (BigInt(aSeq) === BigInt(bSeq)) return 0;
  return BigInt(aSeq) < BigInt(bSeq) ? -1 : 1;
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
  private url = DEFAULT_URL;
  private connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
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
    const retentionDays = normalizeRetentionDays(cfg.retention_days);
    // Tear the previous connection down first, so that a re-connect — which the generation token
    // explicitly advertises as safe — cannot orphan a live socket per call until Redis hits
    // maxclients. This also re-baselines the generation, so no prior loop can be revived.
    await this.disconnect();
    this.prefix = cfg.key_prefix ?? 'parley:';
    this.blockMs = cfg.block_ms ?? 2000;
    this.retentionDays = retentionDays;
    this.url = cfg.url ?? DEFAULT_URL;
    this.connectTimeoutMs = cfg.connect_timeout_ms ?? DEFAULT_CONNECT_TIMEOUT_MS;
    const client = createRedisClient(this.url, this.connectTimeoutMs);
    try {
      await withDeadline(
        client.connect(),
        this.connectTimeoutMs,
        unreachable(this.url, this.connectTimeoutMs),
      );
    } catch (err) {
      await client.disconnect().catch(() => undefined);
      throw err;
    }
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
    // Validate the opaque cursor at the seam. A cursor this backend mints is a stream entry id
    // (`<ms>[-<seq>]`); anything else — another backend's cursor, or '' / '$' / a truncated id via
    // mis-namespaced read-state — would otherwise reach XRANGE as a raw `ERR Invalid stream ID`
    // naming neither backend nor topic. Throw labelled so core can drop it and refetch the window.
    if (args.since !== undefined && !CURSOR_PATTERN.test(args.since)) {
      throw new Error(
        `parley-redis: malformed cursor '${args.since}' for topic ${args.topic} — ` +
          `expected a Redis Stream entry id ('<ms>' or '<ms>-<seq>') minted by this backend`,
      );
    }
    let since: string | undefined = args.since;
    let entries: Array<{ id: string; message: Record<string, string> }>;
    if (since === undefined) {
      // Default window: the most recent `limit` entries, returned ascending by cursor.
      entries = (await this.require().xRevRange(key, '+', '-', { COUNT: limit })).reverse();
    } else {
      // Exclusive: strictly after `since`, ascending. `(` makes XRANGE start exclusive.
      entries = await this.require().xRange(key, `(${since}`, '+', { COUNT: limit });
      // A well-formed but STALE cursor — minted against a different Redis, a re-created dataset, or
      // by a peer whose clock ran ahead, so it sorts past this stream's last generated id — is
      // treated exactly like `since === undefined` for both the query AND the returned cursor, so
      // that on-start catch-up SELF-HEALS. Echoing the dead cursor back instead wedges this topic
      // forever: every later fetch returns the same empty page, with no error to retry and no
      // signal to distinguish it from "nothing new". Checked only once XRANGE came back empty — a
      // non-empty page already proves the cursor is live, so the common path costs no round trip.
      if (entries.length === 0 && (await this.isStaleCursor(key, since))) {
        since = undefined;
        entries = (await this.require().xRevRange(key, '+', '-', { COUNT: limit })).reverse();
      }
    }
    if (since !== undefined && entries.length === 0) {
      // Native long-poll (issue #20): the canonical XRANGE was empty and the caller granted a
      // budget → wait up to `blockMs` for entries strictly after `since`. XREAD BLOCK is itself
      // the bounded wait, and a Stream entry id IS the cursor, so `XREAD ... STREAMS key <since>`
      // returns exactly the entries a repeated exclusive XRANGE would — same {id, message} shape,
      // same ascending order — mapped identically below. No waiter map, no re-run of XRANGE.
      // Gate on the FLOORED budget: `blockMs` is typed `number`, so a sub-ms hint (e.g. 0.5)
      // passes `> 0` yet floors to 0 — and `XREAD BLOCK 0` blocks FOREVER. Flooring first makes
      // such budgets correctly degrade to "return immediately, empty" (core polls the remainder).
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
   * True if a validated cursor sorts strictly past this stream's last generated id — i.e. it
   * names an entry this stream has never minted, so it came from a different Redis, a re-created
   * dataset, or a clock-skewed peer.
   */
  private async isStaleCursor(key: string, since: string): Promise<boolean> {
    return compareIds(since, await this.lastGeneratedId(key)) > 0;
  }

  /** The stream's last generated id, or `0-0` when the stream does not exist yet. */
  private async lastGeneratedId(key: string): Promise<string> {
    const tail = await streamTail(this.require(), key);
    return tail === '0' ? '0-0' : tail;
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
    const reader = this.newReader();
    // Register BEFORE connecting so a disconnect() racing this window can always find and close the
    // reader (mirrors the subscribe() pattern); registering after connect leaks a fresh duplicate.
    this.readers.push(reader);
    try {
      await this.connectReader(reader);
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
   * poll timer). Starts at the stream tail (new entries only; history is owned by catch-up).
   * `disconnect()` tears the reader down, which breaks the blocking read.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    // Capture the generation this subscribe belongs to; every continuation below is gated on it
    // still being current, so a disconnect()/reconnect that ran meanwhile tears this loop down.
    const gen = this.generation;
    const reader = this.newReader();
    // Register BEFORE connecting so a disconnect() racing this window can always find and close
    // the reader (BUG-37); registering after connect leaks a freshly-connected duplicate.
    this.readers.push(reader);
    try {
      await this.connectReader(reader);
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
    let lastId: string;
    try {
      lastId = await streamTail(reader, key);
    } catch (err) {
      this.dropReader(reader);
      await reader.disconnect().catch(() => undefined);
      // A disconnect() racing the probe already tore the registered reader down; that is a
      // superseded subscription, not a fault to surface.
      if (gen !== this.generation) return;
      throw err;
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

  /**
   * A dedicated connection for a blocking read. Built from the same fail-fast options as the
   * command client rather than `duplicate()`d from it, so that a reader opened while Redis is
   * unreachable rejects instead of retrying forever and hanging `subscribe()`.
   */
  private newReader(): RedisClient {
    this.require();
    return createRedisClient(this.url, this.connectTimeoutMs);
  }

  private async connectReader(reader: RedisClient): Promise<void> {
    await withDeadline(
      reader.connect(),
      this.connectTimeoutMs,
      unreachable(this.url, this.connectTimeoutMs),
    );
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
