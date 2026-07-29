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
const DEFAULT_KEY_PREFIX = 'parley:';
const DEFAULT_CONNECT_TIMEOUT_MS = 5000;
const DEFAULT_BLOCK_MS = 2000;
/** Every key `backend_config` may carry; anything else is a typo and is rejected by `connect()`. */
export const CONFIG_KEYS = [
  'url',
  'key_prefix',
  'block_ms',
  'connect_timeout_ms',
  'retention_days',
] as const;
/** A Redis Stream entry id — `<ms>` or `<ms>-<seq>`. Cursors and backendMsgIds are exactly this. */
const CURSOR_PATTERN = /^\d+(-\d+)?$/;
/** Both components of a stream entry id are unsigned 64-bit; a larger one is not an id at all. */
const MAX_ID_COMPONENT = 18446744073709551615n;
/** The sender of an entry written by something other than this plugin, which carries no `sender`. */
const UNKNOWN_SENDER = 'unknown';
/**
 * RESP error codes the server returns when it UNDERSTOOD a command and refused it — a bad
 * argument, a revoked ACL, a repurposed key. Retrying cannot clear any of them without an operator.
 * Everything else (socket faults, `LOADING`, failover redirects) heals on its own and is retried.
 */
const PERMANENT_SERVER_ERROR = /^(ERR|NOAUTH|WRONGPASS|NOPERM|WRONGTYPE|NOPROTO|EXECABORT)\b/;

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Plugin-specific backend_config. */
export interface RedisBackendConfig {
  /** Connection URL. Default `redis://127.0.0.1:6379`. */
  url?: string;
  /** Stream key prefix. Default `parley:`. One Redis Stream per topic: `<prefix><topic>`. */
  key_prefix?: string;
  /**
   * `XREAD BLOCK` timeout (ms) — the `subscribe` loop re-checks for shutdown each interval. Default
   * 2000. Must be a positive whole number; anything else is rejected by `connect()`.
   */
  block_ms?: number;
  /**
   * How long the FIRST handshake (and its verifying `PING`) may take before `connect()` rejects
   * (ms). Default 5000. Must be a positive whole number; anything else is rejected by `connect()`.
   */
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
  client.on('error', (err: unknown) => {
    // The offline queue is disabled, so faults surface as command rejections; don't crash.
    if (err instanceof Error) lastEmittedError.set(client, err);
  });
  return client;
}

/**
 * The most recent `error` event per client. A handshake rejected by the SERVER (`WRONGPASS`, a
 * TLS-only listener) reaches the caller as the reconnect strategy's generic unreachable message,
 * so the emitted `ErrorReply` is the only place the real cause survives.
 */
const lastEmittedError = new WeakMap<object, Error>();

/** The RESP error the server answered with, if the failure was a refusal rather than a socket fault. */
function serverRefusal(err: unknown): string | undefined {
  const message = err instanceof Error ? err.message : '';
  return PERMANENT_SERVER_ERROR.test(message) ? message : undefined;
}

/**
 * A server that is reachable but cannot serve the seam. Distinct from {@link unreachable}, so that
 * an operator debugging a `WRONGPASS` is not sent to look at the network instead of the credential.
 */
function refused(url: string, respError: string): string {
  return `parley-redis: connected to ${endpointOf(url)} but the server refused a command: ${respError}`;
}

/** A server that completed the handshake and then did not answer the first command in time. */
function unresponsive(url: string, connectTimeoutMs: number): string {
  return (
    `parley-redis: connected to ${endpointOf(url)} but it did not answer PING within ` +
    `connect_timeout_ms=${connectTimeoutMs}`
  );
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

/** Render a rejected config value for an operator; `JSON.stringify` alone turns NaN into `null`. */
function describeValue(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value) ?? String(value);
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
        `(got ${describeValue(value)}); omit it (or set null) to keep every entry forever`,
    );
  }
  return value;
}

/**
 * Reject a key `backend_config` does not declare, so that `retention_dayz` or `keyprefix` cannot be
 * accepted in silence and take the DEFAULT behaviour: history kept forever, or a keyspace that
 * differs from every peer session's while every field still reads as consistent.
 */
function assertKnownKeys(cfg: Record<string, unknown>): void {
  for (const key of Object.keys(cfg)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `parley-redis: unknown backend_config key '${key}' — expected one of ` +
          `${CONFIG_KEYS.join(', ')}`,
      );
    }
  }
}

/**
 * Keep the empty-string and wrong-type rejections, so that an unexpanded `"${REDIS_URL}"` — or any
 * other empty secret — cannot fall through to node-redis' own default and quietly point the whole
 * bridge at an unauthenticated `127.0.0.1:6379`, nor a non-string `key_prefix` template-coerce into
 * a keyspace (`[object Object]parley:`) no peer session shares. `null` means "omitted" (DESIGN §11).
 */
function normalizeString(key: string, value: unknown, fallback: string): string {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'string' || value === '') {
    throw new Error(
      `parley-redis: ${key} must be a non-empty string (got ${describeValue(value)}); ` +
        `omit it for the default '${fallback}'`,
    );
  }
  return value;
}

/**
 * Every millisecond knob reaches a place where a nonsensical value is SILENT rather than loud:
 * `block_ms` becomes an `XREAD BLOCK` argument, where `-1`/`0.5`/`NaN` make the server reject every
 * read — killing live push forever behind a `subscribe()` that resolved — and `0` blocks the reader
 * forever; `connect_timeout_ms` becomes a deadline, where `0` fails every connect against a healthy
 * server. Reject at `connect()`, as `retention_days` already does.
 */
function normalizeMillis(key: string, value: unknown, fallback: number): number {
  if (value === undefined || value === null) return fallback;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
    throw new Error(
      `parley-redis: ${key} must be a positive whole number of milliseconds ` +
        `(got ${describeValue(value)}); omit it for the default ${fallback}`,
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
 * from-the-beginning replay of the whole retained history as live push.
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

/**
 * Validate the opaque cursor at the seam. A cursor this backend mints is a stream entry id
 * (`<ms>[-<seq>]`); anything else — another backend's cursor, `''`/`'$'`, a truncated id via
 * mis-namespaced read-state, or an all-digit string too large for the uint64 each component is —
 * would otherwise reach XRANGE as a raw `ERR Invalid stream ID` naming neither backend nor topic.
 * Throw labelled so core can drop it and refetch the window.
 */
function assertMintedCursor(topic: Topic, since: string): void {
  const wellFormed =
    CURSOR_PATTERN.test(since) && since.split('-').every((part) => BigInt(part) <= MAX_ID_COMPONENT);
  if (!wellFormed) {
    throw new Error(
      `parley-redis: malformed cursor '${since}' for topic ${topic} — ` +
        `expected a Redis Stream entry id ('<ms>' or '<ms>-<seq>') minted by this backend`,
    );
  }
}

/**
 * Keep every backend refusal labelled, so that a repurposed key or a revoked ACL reaches the
 * operator naming the plugin, the topic and the Redis key rather than as a bare RESP line
 * (`WRONGTYPE Operation against a key holding the wrong kind of value`) that names none of them and
 * cannot be traced back to which topic, prefix or process produced it.
 */
async function labelled<T>(topic: Topic, key: string, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (message.startsWith('parley-redis:')) throw err;
    throw new Error(`parley-redis: ${message} (topic ${topic}, key '${key}')`);
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
  private blockMs = DEFAULT_BLOCK_MS;
  private retentionDays?: number;
  private url = DEFAULT_URL;
  private connectTimeoutMs = DEFAULT_CONNECT_TIMEOUT_MS;
  /**
   * Per-connect generation token. Bumped on every `connect()`/`disconnect()`; each `subscribe()`
   * captures the current value and gates its read loop on `gen === this.generation`. Because it
   * only ever increases, a torn-down (or superseded) loop can never be revived by a later
   * `connect()` — unlike a shared mutable boolean that a reconnect could reset.
   */
  private generation = 0;
  private readonly readers: RedisClient[] = [];
  /**
   * Readers whose `connect()` has not settled yet. Keep the exclusion in `tearDown`, so that a
   * reader is never disconnected mid-handshake: node-redis assigns its socket only once the TCP
   * connect resolves, so a `disconnect()` before that flips the client to closed WITHOUT a socket
   * to destroy, the handshake then completes onto a live socket, and every later `disconnect()`
   * throws `ClientClosedError` — an orphan nothing can ever close. Whoever is awaiting the connect
   * closes it on the next generation check instead.
   */
  private readonly connecting = new Set<RedisClient>();
  /**
   * Serializes `connect`/`disconnect`. Keep it, so that two overlapping lifecycle calls cannot both
   * open a command client: each reads `this.client` before the other assigns it, and the loser's
   * socket is then referenced by nothing and can never be closed — a permanent leak that also holds
   * the event loop open at shutdown.
   */
  private lifecycle: Promise<unknown> = Promise.resolve();

  async connect(config: BackendConfig): Promise<void> {
    return this.serialize(() => this.open(config as RedisBackendConfig));
  }

  async disconnect(): Promise<void> {
    return this.serialize(() => this.tearDown());
  }

  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const settled = this.lifecycle.then(
      () => undefined,
      () => undefined,
    );
    const run = settled.then(work);
    this.lifecycle = run.catch(() => undefined);
    return run;
  }

  private async open(cfg: RedisBackendConfig): Promise<void> {
    assertKnownKeys(cfg as Record<string, unknown>);
    const url = normalizeString('url', cfg.url, DEFAULT_URL);
    const prefix = normalizeString('key_prefix', cfg.key_prefix, DEFAULT_KEY_PREFIX);
    const retentionDays = normalizeRetentionDays(cfg.retention_days);
    const blockMs = normalizeMillis('block_ms', cfg.block_ms, DEFAULT_BLOCK_MS);
    const connectTimeoutMs = normalizeMillis(
      'connect_timeout_ms',
      cfg.connect_timeout_ms,
      DEFAULT_CONNECT_TIMEOUT_MS,
    );
    // Tear the previous connection down first, so that a re-connect — which the generation token
    // explicitly advertises as safe — cannot orphan a live socket per call until Redis hits
    // maxclients. This also re-baselines the generation, so no prior loop can be revived.
    await this.tearDown();
    this.prefix = prefix;
    this.blockMs = blockMs;
    this.retentionDays = retentionDays;
    this.url = url;
    this.connectTimeoutMs = connectTimeoutMs;
    const client = createRedisClient(this.url, this.connectTimeoutMs);
    try {
      await withDeadline(
        client.connect(),
        this.connectTimeoutMs,
        unreachable(this.url, this.connectTimeoutMs),
      );
      // Verify one COMMAND, not just the handshake: node-redis reports a password-protected server
      // reached without credentials as a successful connect, so without this the bridge comes up
      // "connected" and every seam call fails afterwards — invisibly when catchup.on_start is off.
      await withDeadline(
        client.ping(),
        this.connectTimeoutMs,
        unresponsive(this.url, this.connectTimeoutMs),
      );
    } catch (err) {
      const respError = serverRefusal(err) ?? serverRefusal(lastEmittedError.get(client));
      await client.disconnect().catch(() => undefined);
      throw respError !== undefined ? new Error(refused(this.url, respError)) : err;
    }
    this.client = client;
  }

  private async tearDown(): Promise<void> {
    this.generation++; // supersede every in-flight/straggler subscribe loop so they exit deterministically
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
    const id = await labelled(topic, key, () =>
      this.require().xAdd(
        key,
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
      ),
    );
    return asBackendMsgId(id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const key = this.key(args.topic);
    return labelled(args.topic, key, () => this.readWindow(args, key));
  }

  private async readWindow(args: FetchRecentArgs, key: string): Promise<FetchRecentResult> {
    const limit = args.limit ?? 100;
    if (args.since !== undefined) assertMintedCursor(args.topic, args.since);
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
      // Native long-poll: the canonical XRANGE was empty and the caller granted a
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
    return labelled(topic, this.key(topic), () => this.startReadLoop(topic, handler));
  }

  private async startReadLoop(topic: Topic, handler: MessageHandler): Promise<void> {
    // Capture the generation this subscribe belongs to; every continuation below is gated on it
    // still being current, so a disconnect()/reconnect that ran meanwhile tears this loop down.
    const gen = this.generation;
    const reader = this.newReader();
    // Register BEFORE connecting so a disconnect() racing this window can always find and close
    // the reader; registering after connect leaks a freshly-connected duplicate.
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
        } catch (err) {
          if (gen !== this.generation) break; // torn down/superseded → exit, never spin-retry
          const respError = serverRefusal(err);
          if (respError !== undefined) {
            this.dropReader(reader);
            await reader.disconnect().catch(() => undefined);
            reportLiveDeliveryStopped(topic, respError);
            break;
          }
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
    this.connecting.add(reader);
    try {
      await withDeadline(
        reader.connect(),
        this.connectTimeoutMs,
        unreachable(this.url, this.connectTimeoutMs),
      );
    } finally {
      this.connecting.delete(reader);
    }
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

/**
 * Keep this stderr line, so that a live path which can no longer deliver does not look identical to
 * a quiet topic: `subscribe()` has already resolved, core keeps advertising this instance as
 * subscribed to the topic, and nothing else in the process would ever mention the fault. stdout is
 * the MCP JSON-RPC channel — diagnostics only ever go to stderr.
 */
function reportLiveDeliveryStopped(topic: Topic, respError: string): void {
  process.stderr.write(
    `parley-redis: live delivery STOPPED for topic '${topic}' — the server refused the stream ` +
      `read: ${respError}. Catch-up still works; fix the cause and restart the bridge.\n`,
  );
}

/**
 * Anyone with access to the Redis can `XADD` to a parley stream, and a stream outlives the plugin
 * version that created it, so an entry written without this plugin's fields still has to normalize
 * into a Message that satisfies the DESIGN §5 contract rather than one with an unparseable
 * timestamp and an empty sender that collides with every other empty sender.
 */
function rowToMessage(topic: Topic, id: string, fields: Record<string, string>): Message {
  const sender = fields.sender ?? '';
  return buildMessage({
    topic,
    sender: sender === '' ? UNKNOWN_SENDER : sender,
    content: fields.content ?? '',
    timestamp: entryTimestamp(id, fields.ts),
    id,
  });
}

/** The entry's own `ts` when it is a real date, else the stream id's own millisecond component. */
function entryTimestamp(id: string, ts: string | undefined): string {
  if (ts !== undefined && !Number.isNaN(Date.parse(ts))) return ts;
  const ms = Number(id.split('-')[0]);
  return new Date(Number.isSafeInteger(ms) && ms >= 0 ? ms : 0).toISOString();
}
