import {
  asBackendMsgId,
  asCursor,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  buildMessage,
  type Cursor,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type Message,
  type MessageHandler,
  MIN_HASH_LEN,
  safeName,
  type Topic,
} from '@sharptrick/parley-core';
import {
  DEFAULT_DEADLINE_MS,
  delay,
  fetchWithRetry,
  isLoopbackHost,
  plaintextRemoteOrigin,
  retryAfterFromHeader,
} from '@sharptrick/parley-net-util';
import { createHash } from 'node:crypto';

/** Every `preset` a config may ask for. Each member is graded and documented in the README table. */
export const ROOM_PRESETS = ['private_chat', 'public_chat'] as const;
export type RoomPreset = (typeof ROOM_PRESETS)[number];

/** Plugin-specific backend_config. */
export interface MatrixBackendConfig {
  /**
   * Homeserver base URL. Default `http://127.0.0.1:8008`. `http://` to anything but loopback ships
   * {@link password} and the access token it returns across the network in the clear, and
   * `connect()` warns about it; use `https://` for a remote homeserver.
   */
  homeserver_url?: string;
  /** Login user localpart. Default `parley`. */
  user?: string;
  /** Login password. Default `parleypass`. */
  password?: string;
  /** Homeserver `server_name` used to build room aliases. Default `parley.local`. */
  server_name?: string;
  /**
   * Sync long-poll timeout (ms) — a positive whole number, at most {@link MAX_SYNC_TIMEOUT_MS}. The
   * loop re-checks shutdown each interval. Default 25000.
   */
  sync_timeout_ms?: number;
  /**
   * OPTIONAL shared-room mode (test fixtures / rate-limited deployments). When set to an alias
   * localpart, EVERY topic maps to this one room instead of `#parley_<topic>`, and topics are
   * isolated by a `app.parley.topic` tag carried on each event (filtered on read and on the live
   * path). Synapse rate-limits *room creation* hard (~2-room burst, then ~1 room / 45s per user),
   * while message send/read/sync are unthrottled — so a one-room-per-topic suite is infeasible for
   * an unprivileged login. A production deployment runs the bridge as a rate-limit-exempt
   * appservice and leaves this UNSET to get a real Matrix room per topic. See README.
   *
   * SECURITY: the `app.parley.topic` tag is UNTRUSTED, member-writable event content with no
   * server-enforced integrity — any member of the shared room can send a message whose tag names an
   * arbitrary topic (including the reserved presence topic, entering `computeRoster` under its own
   * homeserver-stamped sender). So in `shared_room` mode inbound data chooses which topic/allowlist
   * bucket a message lands in. This mode is for TEST FIXTURES / rate-limited deployments ONLY and
   * MUST NOT carry mutually-distrusting topics. Production leaves this UNSET: one physically separate
   * Matrix room per topic, where the tag is ignored (rooms are the isolation boundary).
   */
  shared_room?: string;
  /**
   * `preset` for rooms this plugin CREATES. Default `private_chat` → `join_rule: invite`, so a
   * guessable alias (`#parley_<topic>:<server_name>`) does not let an uninvited account on the
   * homeserver (or, under federation, anywhere) read the topic's history or inject `<channel>`
   * events into a live agent session. Set `public_chat` only for a deliberately human-joinable
   * room; peers you want in an invite-only room go in {@link invite}.
   *
   * Keep Matrix's third preset, `trusted_private_chat`, out of {@link ROOM_PRESETS} AND refused at
   * run time by {@link validateConfig}, so that no config can hand every invitee power level 100 —
   * which lets any of them flip `m.room.join_rules` to public and defeat the guarantee above.
   */
  room_preset?: RoomPreset;
  /** MXIDs invited to rooms this plugin creates (an invite-only room admits nobody else). */
  invite?: string[];
}

/** Custom event-content key tagging the logical Parley topic (shared-room isolation + provenance). */
const TOPIC_KEY = 'app.parley.topic';

const DEFAULT_HOMESERVER_URL = 'http://127.0.0.1:8008';

/** Largest delay Node's timers accept; past it every one of them silently becomes 1ms. */
const MAX_TIMER_MS = 2 ** 31 - 1;

/**
 * Largest accepted `sync_timeout_ms`: the one this plugin can still arm a real transport deadline
 * for, since every `/sync` is bounded by {@link syncDeadlineMs} of it.
 */
export const MAX_SYNC_TIMEOUT_MS = MAX_TIMER_MS - DEFAULT_DEADLINE_MS;

const isHttpUrl = (s: string): boolean => {
  try {
    const { protocol } = new URL(s);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
};

/**
 * Reject every `backend_config` value the declared type cannot enforce at run time. Core loads
 * `backend_config` as `z.record(z.unknown())`, so each knob below arrives unchecked and goes
 * straight onto the `POST /createRoom` wire or into the park arithmetic. Keep this a LOAD ERROR
 * rather than a coercion or a warning, so that an unsupported privilege or timing knob fails the way
 * `skip_permissions: true` does instead of taking effect in a shape nothing else in the plugin
 * expects.
 */
function validateConfig(cfg: MatrixBackendConfig): void {
  const reject = (key: keyof MatrixBackendConfig, expected: string, why = ''): never => {
    const raw = cfg[key];
    throw new Error(
      `[parley-matrix] backend_config.${key} = ` +
        `${typeof raw === 'string' ? JSON.stringify(raw) : String(raw)} is not accepted: ` +
        `expected ${expected}.${why}`,
    );
  };
  for (const key of ['homeserver_url', 'user', 'password', 'server_name', 'shared_room'] as const) {
    const v = cfg[key];
    if (v !== undefined && (typeof v !== 'string' || v.length === 0)) {
      reject(key, 'a non-empty string');
    }
  }
  if (cfg.homeserver_url !== undefined && !isHttpUrl(cfg.homeserver_url)) {
    reject('homeserver_url', 'an http(s) URL');
  }
  const timeout = cfg.sync_timeout_ms;
  if (
    timeout !== undefined &&
    !(Number.isInteger(timeout) && timeout > 0 && timeout <= MAX_SYNC_TIMEOUT_MS)
  ) {
    reject(
      'sync_timeout_ms',
      `a positive whole number of milliseconds, at most ${MAX_SYNC_TIMEOUT_MS} (default 25000)`,
      ` The ceiling is Node's ${MAX_TIMER_MS}ms timer range less the ${DEFAULT_DEADLINE_MS}ms call ` +
        'budget every /sync adds on top of it: past it the transport deadline clamps to 1ms, so ' +
        'every /sync aborts client-side at once and the live path dies blaming the homeserver.',
    );
  }
  const invite = cfg.invite;
  if (
    invite !== undefined &&
    (!Array.isArray(invite) || invite.some((m) => typeof m !== 'string' || m.length === 0))
  ) {
    reject('invite', 'an array of non-empty MXID strings');
  }
  if (
    cfg.room_preset !== undefined &&
    !(ROOM_PRESETS as readonly string[]).includes(cfg.room_preset)
  ) {
    reject(
      'room_preset',
      `one of ${ROOM_PRESETS.join(', ')}`,
      " Matrix's `trusted_private_chat` is refused deliberately: it hands every invitee power " +
        'level 100, so any of them can flip m.room.join_rules to public and defeat the invite-only ' +
        'guarantee the default preset exists for.',
    );
  }
}

/** Repo-public login password every dev fixture ships with; never a secret. */
const DEFAULT_PASSWORD = 'parleypass';

/**
 * Every config shape that widens this backend's trust boundary, phrased for the operator's stderr.
 * A risk documented only in the README is one an operator who copied a fixture config never sees,
 * so each of these warns from {@link MatrixPlugin.connect} — a warning rather than a load error,
 * because each is a legitimate choice for a fixture or a rate-limited deployment.
 */
function configRisks(cfg: MatrixBackendConfig): string[] {
  const risks: string[] = [];
  const plaintext = plaintextRemoteOrigin(cfg.homeserver_url ?? DEFAULT_HOMESERVER_URL);
  if (plaintext !== undefined) {
    risks.push(
      `backend_config.homeserver_url ${plaintext} is plaintext http:// to a non-loopback host, so ` +
        'the m.login.password POST carries backend_config.password across the network in the ' +
        'clear, and the access token it returns rides every later request the same way. Use ' +
        'https:// for any remote homeserver.',
    );
  }
  if (cfg.password === undefined || cfg.password === DEFAULT_PASSWORD) {
    risks.push(
      `connecting with the built-in default password ('${DEFAULT_PASSWORD}'). Set ` +
        'backend_config.password to a real secret; a network-reachable homeserver provisioned ' +
        'with this password is world-readable/injectable.',
    );
  }
  if (cfg.shared_room !== undefined) {
    risks.push(
      `backend_config.shared_room (${JSON.stringify(cfg.shared_room)}) folds EVERY topic into one ` +
        `Matrix room, isolated only by the member-forgeable '${TOPIC_KEY}' event tag: any member ` +
        'of that room can post a message tagged with any other topic, including the presence ' +
        'topic. Leave shared_room unset in production so each topic gets its own room.',
    );
  }
  if (cfg.room_preset === 'public_chat') {
    risks.push(
      "backend_config.room_preset 'public_chat' makes every room this bridge creates joinable by " +
        'any account on the homeserver (and, under federation, beyond) via its guessable alias — ' +
        "which admits readers of the topic's history and injectors of live agent events. Use the " +
        "default 'private_chat' with backend_config.invite unless the room is deliberately open.",
    );
  }
  return risks;
}



/**
 * Wall-clock budget for a `/sync` that asks the homeserver to block for `timeoutMs`. A long-poll
 * legitimately outlives the shared {@link DEFAULT_DEADLINE_MS}, so every `/sync` call MUST pass
 * this — at the default budget any `sync_timeout_ms` at or above 30000 aborts client-side before a
 * conforming homeserver has answered, and the live path degrades to the retry backoff instead.
 * Bounded above by {@link MAX_SYNC_TIMEOUT_MS}, which {@link validateConfig} enforces so the result
 * always fits a Node timer.
 */
export const syncDeadlineMs = (timeoutMs: number): number => timeoutMs + DEFAULT_DEADLINE_MS;

/**
 * Cursor minted for a window that contained no belonging message: an opaque `/messages`
 * pagination token marking the position the window was read AT, so replaying it returns exactly
 * what has landed since. Never mint `''` here — an empty cursor 404s on `/context` and would be
 * decoded as an EXPIRED cursor, silently dropping everything older than the recent window.
 */
const STREAM_CURSOR_PREFIX = '@parley-stream:';

/**
 * A pending native long-poll (`fetchRecent` with `blockMs`) parked on a room. `topic` is the logical
 * topic it is caught up to (its exclusive `since` floor); `wake` fires EXACTLY once — when a
 * belonging live event lands (delivered by the running `subscribe` loop, or observed by a dedicated
 * bounded `/sync` when no loop runs), at the `blockMs` timeout, or on `disconnect()` — and tears
 * down its own timer, registration, and any dedicated `/sync`.
 */
interface Waiter {
  topic: Topic;
  wake: () => void;
}

/**
 * A Matrix timeline event as it arrives. Every field is member-controlled JSON on which the
 * homeserver enforces no schema. Keep these `unknown`, so that no value reaches `buildMessage`
 * without passing a guard — a throw here rejects `fetchRecent`, which bricks startup catch-up.
 */
interface MatrixEvent {
  type?: unknown;
  event_id?: unknown;
  sender?: unknown;
  origin_server_ts?: unknown;
  content?: unknown;
}

/** An `m.room.message` carrying the one field the seam cannot synthesize: a usable id. */
type MessageEvent = MatrixEvent & { event_id: string };

const isMessageEvent = (e: MatrixEvent): e is MessageEvent =>
  e.type === 'm.room.message' && typeof e.event_id === 'string';

const contentOf = (e: MatrixEvent): Record<string, unknown> =>
  typeof e.content === 'object' && e.content !== null ? (e.content as Record<string, unknown>) : {};

/** Real per-sync timeline cap for the incremental `/sync` filter and the backfill page size. */
const INCREMENTAL_TIMELINE_LIMIT = 100;
/**
 * Floor on how long any park may last, independent of `sync_timeout_ms`. Every slice ends in a full
 * canonical catch-up (`/context` + `/messages`) or an alias lookup, so keep this floor, so that a
 * small — but perfectly legal — `sync_timeout_ms` cannot turn one idle wait into thousands of
 * homeserver requests and spend the deployment's rate-limit budget on nothing.
 */
const MIN_PARK_SLICE_MS = 250;
/**
 * Pace between `/sync` calls that came back far sooner than the long-poll they asked for. A
 * conforming homeserver blocks server-side; keep the pace, so that a non-blocking or degenerate one
 * cannot hot-spin a loop that has no deadline to stop it.
 */
const SYNC_IDLE_PACE_MS = 25;

/**
 * Whether a `/sync` answered so fast that the loop must pace itself. Keep the pace floor as well as
 * the half-timeout test, so that a SMALL `sync_timeout_ms` — for which half the timeout is already
 * shorter than a round-trip — cannot make the guard unreachable and reopen the hot spin.
 */
const returnedTooFast = (startedAt: number, timeoutMs: number): boolean =>
  Date.now() - startedAt < Math.max(timeoutMs / 2, SYNC_IDLE_PACE_MS);
/** Bound on forward catch-up pagination so an all-foreign timeline terminates instead of spinning. */
const MAX_FORWARD_PAGES = 50;
/** Bound on backward `limited`-burst recovery pagination so it always terminates. */
const MAX_BACKFILL_PAGES = 50;
/**
 * Server-side `/messages` filter for the catch-up paths: reactions, edits, and membership churn
 * then cost no client page budget at all. Keep it OFF the `backfill`/`timelineTip` pair — those
 * match a boundary `event_id` that may itself be a state event, which a filtered page would hide.
 */
const MESSAGES_ONLY_FILTER = encodeURIComponent(JSON.stringify({ types: ['m.room.message'] }));

/**
 * Matrix (Synapse) backend (DESIGN §6/§9) — first external-network backend, over the raw
 * Client-Server HTTP API (no SDK; unencrypted rooms). By default a topic maps to its own room via
 * the canonical alias `#parley_<topic>:<server_name>`. The Matrix `event_id` is globally unique and
 * serves as BOTH `backendMsgId` (dedup key) AND `cursor` (order key). "Strictly after a cursor" is
 * resolved server-side: `/context/<event_id>` → a forward pagination token → `/messages?dir=f`. The
 * live path is a filtered `/sync` long-poll loop (timeline limit 0 skips history). Core never
 * compares cursor values — the homeserver's stream ordering is the single source of order.
 *
 * `shared_room` mode (see {@link MatrixBackendConfig.shared_room}) folds all topics into one room,
 * isolating them by an `app.parley.topic` content tag — the only practical way to run the suite
 * under Synapse's strict per-user room-creation rate limit without an appservice.
 */
export class MatrixPlugin implements BackendPlugin {
  private baseUrl = 'http://127.0.0.1:8008';
  private serverName = 'parley.local';
  private user = 'parley';
  private password = DEFAULT_PASSWORD;
  private syncTimeoutMs = 25_000;
  private roomPreset: RoomPreset = 'private_chat';
  private invite: string[] = [];
  /** Set → shared-room mode: alias localpart every topic resolves to; else per-topic rooms. */
  private sharedLocalpart?: string;
  private token?: string;
  private userId?: string;
  private stopped = false;
  /**
   * Bumped by every {@link connect}. Background work captures it and stands down when it no longer
   * matches — keep it, so that a loop parked in a retry backoff across a `disconnect()` cannot be
   * resurrected by the next `connect()` clearing {@link stopped}, and run on against a stale token,
   * room and handler.
   */
  private generation = 0;
  private txnCounter = 0;
  /** room cache key → room_id, deduped so concurrent first-posts share one create/resolve. */
  private readonly rooms = new Map<string, Promise<string>>();
  /** In-flight sync long-polls, aborted on disconnect so teardown is immediate. */
  private readonly controllers = new Set<AbortController>();
  /**
   * room_id → the native long-poll waiters parked on it. Populated only while a
   * `fetchRecent({ blockMs })` blocks. Woken by the running `subscribe` loop's delivery when one
   * drives this topic (see {@link liveTopics}); otherwise by a dedicated bounded `/sync`. Drained on
   * wake/timeout/disconnect. Independent of `subscribe` — a blocking fetch needs no active route.
   */
  private readonly waiters = new Map<string, Set<Waiter>>();
  /**
   * (room_id, topic) pairs with a live `subscribe` `/sync` loop running AND already positioned. A
   * blocking `fetchRecent` hooks that loop's delivery (no second `/sync`) only when its OWN pair is
   * here; otherwise it drives its own bounded `/sync`. Keep both halves — the loop wakes waiters for
   * the one topic it delivers, so a room-only key would let `subscribe(A)` starve a waiter on topic
   * B in `shared_room` mode, and registering before the positioning sync resolves would let a
   * message that lands in that window reach neither the loop nor the waiter.
   */
  private readonly liveTopics = new Set<string>();

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as MatrixBackendConfig;
    // Keep the validation ahead of the stand-down, so that a refused config leaves a working
    // connection running instead of tearing it down on the way to a load error.
    validateConfig(cfg);
    this.generation++;
    this.standDown();
    this.baseUrl = (cfg.homeserver_url ?? DEFAULT_HOMESERVER_URL).replace(/\/+$/, '');
    this.serverName = cfg.server_name ?? 'parley.local';
    this.user = cfg.user ?? 'parley';
    this.password = cfg.password ?? DEFAULT_PASSWORD;
    this.syncTimeoutMs = cfg.sync_timeout_ms ?? 25_000;
    this.roomPreset = cfg.room_preset ?? 'private_chat';
    this.invite = cfg.invite ?? [];
    this.sharedLocalpart = cfg.shared_room;
    this.stopped = false;

    for (const risk of configRisks(cfg)) console.warn(`[parley-matrix] SECURITY: ${risk}`);

    const res = await this.http('POST', '/_matrix/client/v3/login', {
      body: {
        type: 'm.login.password',
        identifier: { type: 'm.id.user', user: this.user },
        password: this.password,
      },
    });
    const json = (await res.json()) as { access_token: string; user_id: string };
    this.token = json.access_token;
    this.userId = json.user_id;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    this.standDown();
    this.token = undefined;
    this.userId = undefined;
  }

  /**
   * End the current generation's background work and empty every registry describing it. Keep BOTH
   * lifecycle entry points on this, so that a bare `connect()` — a reconnect with no preceding
   * `disconnect()` — ends the previous generation's parks at once rather than one park slice later,
   * which at the documented `sync_timeout_ms` is 25 seconds of a caller's `blockMs` spent waiting on
   * a generation that is already gone.
   */
  private standDown(): void {
    for (const c of this.controllers) c.abort();
    this.controllers.clear();
    this.liveTopics.clear();
    this.rooms.clear();
    // Wake every blocked long-poll so its `fetchRecent` returns at once (each wake() clears its timer
    // and registration). Snapshot first — wake() mutates `waiters` — then clear so nothing outlives
    // the teardown; the in-flight `/sync` each drives (if any) was already aborted above.
    const pending = [...this.waiters.values()].flatMap((set) => [...set]);
    this.waiters.clear();
    for (const w of pending) w.wake();
  }

  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    const roomId = await this.ensureRoom(topic);
    const txnId = `parley-${Date.now()}-${this.txnCounter++}-${rand()}`;
    const relation =
      opts?.inReplyTo === undefined
        ? {}
        : { 'm.relates_to': { 'm.in_reply_to': { event_id: String(opts.inReplyTo) } } };
    const res = await this.http(
      'PUT',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/m.room.message/${encodeURIComponent(txnId)}`,
      { body: { msgtype: 'm.text', body: content, [TOPIC_KEY]: topic, ...relation } },
    );
    const json = (await res.json()) as { event_id: string };
    return asBackendMsgId(json.event_id);
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const generation = this.generation;
    const deadline = Date.now() + (args.blockMs ?? 0);
    // Park for the room only when the answer would otherwise be an EMPTY page: the seam blocks on an
    // empty window, not on provisioning, so a topic whose room already exists must not spend the
    // budget re-resolving it.
    const roomId =
      (await this.existingRoom(args.topic, generation)) ??
      ((args.blockMs ?? 0) > 0 ? await this.roomForRead(args.topic, deadline, generation) : undefined);
    const limit = args.limit ?? 100;
    // A topic nobody has posted to has no room yet, and a read never provisions one. An empty page
    // with a replayable cursor is the seam's answer: the `@parley-stream:` form with no token drains
    // from the first visible event once the room does exist.
    if (roomId === undefined) {
      return { messages: [], nextCursor: this.emptyWindowCursor(undefined, args.since, generation) };
    }

    if (args.since === undefined) {
      return this.recentWindow(roomId, args.topic, limit, generation, undefined);
    }

    const first = await this.fetchSince(roomId, args.topic, args.since, limit, generation);

    // Engage the native long-poll ONLY when asked (blockMs > 0) and the exclusive query came back
    // empty — otherwise this is the plain durable catch-up.
    const blockMs = deadline - Date.now();
    if (blockMs <= 0 || first.messages.length > 0 || this.stopped) {
      return first;
    }
    // Wait on the live `/sync` primitive (the same one `subscribe` uses) up to the budget for a new
    // belonging event in the room, then re-run the canonical exclusive `/messages` query so the
    // returned ids/cursor stay canonical. A timeout leaves the empty page + `first`'s cursor.
    return this.blockingFetch(
      roomId,
      args.topic,
      args.since,
      limit,
      blockMs,
      first.nextCursor,
      generation,
    );
  }

  /**
   * The exclusive-`since` catch-up: locate the cursor event and page forward from just after it,
   * returning only belonging messages strictly after `since` plus a monotonic, replayable
   * `nextCursor`. Factored out of {@link fetchRecent} so the native long-poll can re-run the EXACT
   * canonical query on wake.
   */
  private async fetchSince(
    roomId: string,
    topic: Topic,
    sinceCursor: Cursor,
    limit: number,
    generation: number,
  ): Promise<FetchRecentResult> {
    const since = String(sinceCursor);
    if (since.startsWith(STREAM_CURSOR_PREFIX)) {
      const token = since.slice(STREAM_CURSOR_PREFIX.length);
      return this.drainForward(
        roomId,
        topic,
        token || undefined,
        undefined,
        limit,
        sinceCursor,
        generation,
        {
          // A read-state file is editable, truncatable, and survives a `shared_room`/`server_name`
          // change, so this token may be one the homeserver rejects outright (Synapse: 400
          // M_UNKNOWN "'from' parameter is invalid"). Degrade like the `event_id` branch's 404.
          startTokenIsUntrusted: true,
        },
      );
    }
    // Keep the `''` branch: read-state files written before {@link STREAM_CURSOR_PREFIX} existed
    // carry that sentinel, and it must not reach `/context` — see STREAM_CURSOR_PREFIX.
    if (since === '') {
      return this.drainForward(roomId, topic, undefined, undefined, limit, sinceCursor, generation);
    }
    // Exclusive `since`: locate the cursor event, then page forward from just after it.
    const ctxRes = await this.http(
      'GET',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/context/${encodeURIComponent(since)}?limit=0`,
      { allowStatuses: [404] },
    );
    // Keep this fallback rather than throwing on an unresolvable cursor, so that a purged /
    // retention-expired event (or a topic remapped to another room by a `shared_room`/`server_name`
    // change) does not brick startup: `buildBridge` awaits `catchUpAll`, so a throw here fails
    // EVERY restart until the read-state file is hand-edited.
    if (ctxRes.status === 404) {
      return this.recentWindow(roomId, topic, limit, generation, sinceCursor);
    }
    const ctx = (await ctxRes.json()) as { end?: string };
    if (ctx.end === undefined) {
      return { messages: [], nextCursor: sinceCursor };
    }
    return this.drainForward(roomId, topic, ctx.end, since, limit, sinceCursor, generation);
  }

  /**
   * Page the timeline FORWARD from `start` (undefined = the first visible event in the room),
   * collecting up to `limit` messages belonging to `topic`. `sinceEventId`, when given, is made
   * strictly exclusive.
   */
  private async drainForward(
    roomId: string,
    topic: Topic,
    start: string | undefined,
    sinceEventId: string | undefined,
    limit: number,
    sinceCursor: Cursor,
    generation: number,
    opts?: { startTokenIsUntrusted?: boolean },
  ): Promise<FetchRecentResult> {
    const messages: Message[] = [];
    let from = start;
    // Keep tracking the last RAW event id of every FULL page, so that
    // {@link cursorPastForeignBlock} can advance past a page-sized block of foreign-topic or
    // non-message events: `/messages` bounds a page BEFORE filtering, so pinning `nextCursor` at
    // `since` would be indistinguishable from "caught up" and would mask every later on-topic
    // message forever. Keep the FULL-page condition as well — a short page IS the end of the
    // timeline, and advancing there would move the cursor on foreign traffic alone, breaking the
    // seam's stable-cursor contract for every topic that shares a room.
    let lastRawEventId: string | undefined;
    for (
      let page = 0;
      page < MAX_FORWARD_PAGES && messages.length < limit && !this.isStale(generation);
      page++
    ) {
      const fromParam = from === undefined ? '' : `from=${encodeURIComponent(from)}&`;
      const fwdRes = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${fromParam}dir=f&limit=${limit}&filter=${MESSAGES_ONLY_FILTER}`,
        page === 0 && opts?.startTokenIsUntrusted === true
          ? { allowStatuses: [400, 404] }
          : undefined,
      );
      if (!fwdRes.ok) return this.recentWindow(roomId, topic, limit, generation, sinceCursor);
      const { chunk, end } = (await fwdRes.json()) as { chunk: MatrixEvent[]; end?: string };
      if (chunk.length === 0) break; // genuine end of timeline.
      // Keep the `since` event both DROPPED and out of the page-fullness count, so that a
      // homeserver whose `/context` `end` token re-includes it can neither re-deliver it nor make
      // an end-of-timeline page look full and move this topic's cursor on foreign traffic alone.
      const reincluded =
        sinceEventId !== undefined && chunk.some((e) => e.event_id === sinceEventId);
      const rawTail =
        chunk.length - (reincluded ? 1 : 0) >= limit ? chunk.at(-1)?.event_id : undefined;
      if (typeof rawTail === 'string') lastRawEventId = rawTail;
      let events = chunk.filter(isMessageEvent);
      const idx =
        sinceEventId === undefined ? -1 : events.findIndex((e) => e.event_id === sinceEventId);
      if (idx >= 0) events = events.slice(idx + 1);
      events = events.filter((e) => this.belongs(e, topic));
      for (const e of events) messages.push(eventToMessage(topic, e));
      if (end === undefined) break; // no further forward pagination token.
      from = end;
    }
    const trimmed = messages.slice(0, limit);
    return {
      messages: trimmed,
      nextCursor: cursorPastForeignBlock(trimmed, lastRawEventId, sinceCursor),
    };
  }

  /**
   * Native long-poll: park until a belonging live event lands in `roomId`, `blockMs` elapses, or
   * `disconnect()` drains us — then re-run the canonical exclusive `/messages` query so ids/cursor
   * stay canonical. The waiter's `wake` fires EXACTLY once and self-cleans (timer cleared,
   * registration removed, any dedicated `/sync` aborted); it never blocks past `blockMs`.
   *
   * Every empty exit reports `best` — the most advanced cursor the canonical query has produced,
   * seeded from the pre-block one. Keep it threaded rather than reporting `sinceCursor`, so that a
   * blocking call reports the position a non-blocking one would: a cursor pinned at `since` cannot
   * cross a page-sized block of foreign-topic traffic, and everything beyond the forward-page bound
   * is then unreachable for as long as the caller keeps passing `blockMs`.
   *
   * When a `subscribe` loop already drives this topic we
   * hook its delivery ({@link liveTopics}) rather than open a second `/sync`; otherwise we drive a
   * dedicated bounded `/sync` with its OWN since token (never the subscribe loop's, so it cannot
   * corrupt the live loop's position) to observe the wake. The park is spent in slices of
   * {@link syncTimeoutMs}, each ending in the canonical re-query, so promptness never depends on a
   * wake source staying healthy for the whole budget.
   */
  private async blockingFetch(
    roomId: string,
    topic: Topic,
    sinceCursor: Cursor,
    limit: number,
    blockMs: number,
    bestCursor: Cursor,
    generation: number,
  ): Promise<FetchRecentResult> {
    const deadline = Date.now() + blockMs;
    let best = bestCursor;
    // Wait in a loop so a SPURIOUS wake does not end the call early. The dedicated `/sync` can
    // re-deliver an event at/before `sinceCursor`, waking the waiter even though the exclusive
    // re-query is still empty. On such an empty re-query with budget left we re-arm and keep
    // waiting, so the plugin holds the full `blockMs` like the other native backends.
    for (;;) {
      const remaining = deadline - Date.now();
      if (this.isStale(generation) || remaining <= 0) {
        return { messages: [], nextCursor: best };
      }

      let done = false;
      let timer: ReturnType<typeof setTimeout>;
      let syncController: AbortController | undefined;
      let resolveParked!: () => void;
      const parked = new Promise<void>((resolve) => {
        resolveParked = resolve;
      });
      const waiter: Waiter = {
        topic,
        wake: () => {
          if (done) return;
          done = true;
          clearTimeout(timer);
          const set = this.waiters.get(roomId);
          if (set !== undefined) {
            set.delete(waiter);
            if (set.size === 0) this.waiters.delete(roomId);
          }
          if (syncController !== undefined) {
            this.controllers.delete(syncController);
            syncController.abort();
          }
          resolveParked();
        },
      };
      // Keep the park sliced rather than spanning the whole budget, so that a wake source that stops
      // observing — a subscribe loop in retry backoff, a loop stalled mid-backfill, a dedicated
      // `/sync` that failed to position — costs one slice of latency and not the entire blockMs.
      const slice = this.parkSlice(remaining);
      // Keep the registration ahead of everything below, so that a delivery cannot land while this
      // waiter is invisible.
      timer = setTimeout(waiter.wake, slice);
      const set = this.waiters.get(roomId) ?? new Set<Waiter>();
      set.add(waiter);
      this.waiters.set(roomId, set);

      // Keep every exit from here on inside the finally, so that a throw from `fetchSince` cannot
      // strand this waiter's timer, registration and dedicated `/sync` for the rest of `blockMs`.
      try {
        if (this.isStale(generation)) return { messages: [], nextCursor: best };

        if (!this.liveTopics.has(liveKey(roomId, topic))) {
          syncController = new AbortController();
          this.controllers.add(syncController);
          const positioned = this.driveBoundedSync(
            roomId,
            topic,
            slice,
            syncController,
            waiter.wake,
          );
          // Keep this await ahead of the re-query below, so that a message landing in the
          // positioning window is seen by the re-query when the sync's `next_batch` already skipped
          // it. `parked` bounds the wait by the deadline.
          await Promise.race([positioned, parked]);
        }

        if (this.isStale(generation)) return { messages: [], nextCursor: best };
        const recheck = await this.fetchSince(roomId, topic, sinceCursor, limit, generation);
        if (recheck.messages.length > 0) return recheck;
        best = recheck.nextCursor;

        await parked;
        if (this.isStale(generation)) return { messages: [], nextCursor: best };
        const after = await this.fetchSince(roomId, topic, sinceCursor, limit, generation);
        if (after.messages.length > 0) return after;
        best = after.nextCursor;
        // Empty ⇒ the deadline timer fired or the wake was spurious. Loop: the top re-checks the
        // deadline and returns the empty page once the budget is spent, else re-arms.
      } finally {
        waiter.wake();
      }
    }
  }

  /**
   * Position a dedicated, bounded `/sync` used ONLY while a blocking `fetchRecent` waits on a room
   * that no `subscribe` loop covers. Resolves once the `timeout=0` positioning sync's `next_batch`
   * is in hand (its OWN token — never shared with the live loop), leaving {@link pollBoundedSync}
   * running behind it. Best-effort: a positioning failure just returns — the `blockMs` timer still
   * resolves the wait.
   */
  private async driveBoundedSync(
    roomId: string,
    topic: Topic,
    blockMs: number,
    controller: AbortController,
    wake: () => void,
  ): Promise<void> {
    const generation = this.generation;
    const deadline = Date.now() + blockMs;
    const initParam = encodeURIComponent(JSON.stringify(this.syncFilter(roomId, 0)));
    let nextBatch: string;
    try {
      const initial = await this.http(
        'GET',
        `/_matrix/client/v3/sync?filter=${initParam}&timeout=0`,
        { signal: controller.signal, deadlineMs: syncDeadlineMs(0) },
      );
      nextBatch = ((await initial.json()) as { next_batch: string }).next_batch;
    } catch {
      return;
    }
    void this.pollBoundedSync(roomId, topic, deadline, nextBatch, generation, controller, wake);
  }

  /**
   * Long-poll a positioned dedicated `/sync` forward until a belonging event appears (→ `wake()`),
   * the `blockMs` budget runs out, or it is aborted (disconnect/wake). Every `/sync` timeout is
   * clamped to the remaining budget so the total wait never exceeds `blockMs`. Best-effort: any
   * error (an abort included) just returns — the `blockMs` timer still resolves the wait.
   */
  private async pollBoundedSync(
    roomId: string,
    topic: Topic,
    deadline: number,
    positionedAt: string,
    generation: number,
    controller: AbortController,
    wake: () => void,
  ): Promise<void> {
    const incParam = encodeURIComponent(
      JSON.stringify(this.syncFilter(roomId, INCREMENTAL_TIMELINE_LIMIT)),
    );
    let nextBatch = positionedAt;
    try {
      while (!this.isStale(generation) && !controller.signal.aborted) {
        const remaining = deadline - Date.now();
        if (remaining <= 0) return;
        const timeout = Math.min(remaining, this.syncTimeoutMs);
        const started = Date.now();
        const res = await this.http(
          'GET',
          `/_matrix/client/v3/sync?filter=${incParam}&since=${encodeURIComponent(nextBatch)}&timeout=${timeout}`,
          { signal: controller.signal, deadlineMs: syncDeadlineMs(timeout) },
        );
        const json = (await res.json()) as SyncResponse;
        nextBatch = nextBatchOf(json.next_batch, nextBatch);
        const events = json.rooms?.join?.[roomId]?.timeline?.events ?? [];
        if (events.some((e) => this.belongs(e, topic))) {
          wake();
          return;
        }
        if (returnedTooFast(started, timeout)) {
          await delay(Math.min(remaining, SYNC_IDLE_PACE_MS));
        }
      }
    } catch {
      /* aborted (disconnect/wake) or transient — the blockMs timer still resolves the wait */
    }
  }

  /**
   * Most-recent `limit` messages for `topic`, returned ASCENDING. Used for the default
   * (`since`-less) window AND as the fallback when a persisted cursor has expired — its
   * most-recent-`limit`-ascending contract is identical in both cases.
   *
   * Pages BACKWARDS until `limit` BELONGING messages are collected: a `dir=b` page is bounded
   * before topic/type filtering, so a single raw page would report a topic sitting behind `limit`
   * foreign-topic, reaction, or membership events as empty — indistinguishable from a topic that
   * was never written to.
   */
  private async recentWindow(
    roomId: string,
    topic: Topic,
    limit: number,
    generation: number,
    sinceCursor: Cursor | undefined,
  ): Promise<FetchRecentResult> {
    const collected: MessageEvent[] = [];
    let from: string | undefined;
    let tailToken: string | undefined;
    for (
      let page = 0;
      page < MAX_BACKFILL_PAGES && collected.length < limit && !this.isStale(generation);
      page++
    ) {
      const fromParam = from === undefined ? '' : `from=${encodeURIComponent(from)}&`;
      const res = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?${fromParam}dir=b&limit=${limit}&filter=${MESSAGES_ONLY_FILTER}`,
      );
      const { chunk, start, end } = (await res.json()) as {
        chunk: MatrixEvent[];
        start?: string;
        end?: string;
      };
      tailToken ??= start;
      if (chunk.length === 0) break;
      for (const e of chunk) if (this.belongs(e, topic)) collected.push(e);
      if (end === undefined) break;
      from = end;
    }
    const messages = collected
      .slice(0, limit)
      .reverse()
      .map((e) => eventToMessage(topic, e));
    const nextCursor =
      messages.at(-1)?.cursor ?? this.emptyWindowCursor(tailToken, sinceCursor, generation);
    return { messages, nextCursor };
  }

  /**
   * The cursor an EMPTY read reports: the timeline position it was actually read AT (`readAt`, in
   * the `${STREAM_CURSOR_PREFIX}` form rather than `''` — see {@link STREAM_CURSOR_PREFIX} for what
   * minting `''` costs), else the caller's own position.
   *
   * Keep the THROW for a read that observed NEITHER — no page and no `since` — so that a teardown
   * landing before the first page cannot report `@parley-stream:` with no token, which means "the
   * first visible event in the room" and is a position nothing observed. Core's catch-up persists
   * whatever cursor it is handed, so a `disconnect()` racing startup catch-up would otherwise write
   * "beginning of the room" to read-state and re-deliver the whole room on the next start.
   */
  private emptyWindowCursor(
    readAt: string | undefined,
    sinceCursor: Cursor | undefined,
    generation: number,
  ): Cursor {
    if (readAt !== undefined) return asCursor(`${STREAM_CURSOR_PREFIX}${readAt}`);
    if (sinceCursor !== undefined) return sinceCursor;
    if (this.isStale(generation)) {
      throw new Error(
        '[parley-matrix] fetchRecent stood down before it read a page and was given no `since`, so ' +
          'it has no read position to report; the plugin disconnected or reconnected mid-call.',
      );
    }
    return asCursor(STREAM_CURSOR_PREFIX);
  }

  /**
   * Live path = a filtered `/sync` long-poll loop (DESIGN §9 — genuine events, not a poll timer).
   * The initial sync yields a `next_batch` that SKIPS history; the loop then delivers every
   * `m.room.message` for this topic appended after it — INCLUDING our own sends — in timeline order.
   * `disconnect()` aborts the in-flight long-poll and stops the loop.
   */
  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const generation = this.generation;
    const roomId = await this.ensureRoom(topic);
    if (this.isStale(generation)) return;
    // Two filters: the initial position asks for `timeline.limit: 1` — the newest event, never
    // delivered, only the boundary {@link backfill} stops at; the loop uses a REAL timeline limit so
    // a burst that overflows the per-sync cap is reported via `limited`/`prev_batch` (and
    // recoverable) instead of being silently truncated.
    const initParam = encodeURIComponent(JSON.stringify(this.syncFilter(roomId, 1)));
    const incParam = encodeURIComponent(
      JSON.stringify(this.syncFilter(roomId, INCREMENTAL_TIMELINE_LIMIT)),
    );

    // Establish the resume position BEFORE returning, so a post immediately after subscribe()
    // resolves is guaranteed to land in a subsequent sync (positioning is awaited).
    const initial = await this.http('GET', `/_matrix/client/v3/sync?filter=${initParam}&timeout=0`, {
      deadlineMs: syncDeadlineMs(0),
    });
    const positioned = (await initial.json()) as SyncResponse;
    let nextBatch = positioned.next_batch ?? '';
    // Keep this boundary read from the SAME response as `nextBatch`, so that a `limited`-burst
    // {@link backfill} stops EXACTLY at the subscription position: a boundary read one round-trip
    // later swallows everything that landed in between, and one read earlier pages back past the
    // position into PRE-subscription history and leaks it as live events.
    let lastDelivered: string | undefined = timelineTipOf(positioned, roomId);
    // Keep this registration after positioning AND behind the staleness gate, so that a concurrent
    // blocking `fetchRecent` only ever hooks a wake source that is both able to observe its message
    // and still running — a key added by a loop that has already stood down is a permanent phantom.
    if (this.isStale(generation)) return;
    this.liveTopics.add(liveKey(roomId, topic));

    const loop = async (): Promise<void> => {
      let consecutiveFailures = 0;
      while (!this.isStale(generation)) {
        const started = Date.now();
        // Keep EVERY use of the parsed body inside this try, so that a malformed-but-parseable
        // `/sync` — a JSON `null`, a `timeline.events` that is not a list — is reported and backed
        // off like any other fault rather than escaping the loop as an unhandled rejection, which
        // under Node's default terminates the bridge process.
        try {
          let json: SyncResponse;
          const controller = new AbortController();
          this.controllers.add(controller);
          try {
            const res = await this.http(
              'GET',
              `/_matrix/client/v3/sync?filter=${incParam}&since=${encodeURIComponent(nextBatch)}&timeout=${this.syncTimeoutMs}`,
              { signal: controller.signal, deadlineMs: syncDeadlineMs(this.syncTimeoutMs) },
            );
            json = (await res.json()) as SyncResponse;
          } finally {
            this.controllers.delete(controller);
          }
          if (this.isStale(generation)) break;
          consecutiveFailures = 0;
          nextBatch = nextBatchOf(json.next_batch, nextBatch);
          const timeline = json.rooms?.join?.[roomId]?.timeline;
          const events = timeline?.events ?? [];
          // The server truncated this sync's timeline to the filter cap; the omitted (older) events
          // are reachable only by paging `prev_batch` backwards. Recover and deliver them ASCENDING
          // before the new batch so no burst larger than the per-sync cap is silently dropped (the
          // "handler fires once per inbound message" seam contract).
          if (timeline?.limited === true && timeline.prev_batch !== undefined) {
            let recovered: MessageEvent[] = [];
            try {
              recovered = await this.backfill(
                roomId,
                topic,
                timeline.prev_batch,
                lastDelivered,
                new Set(events.map((e) => e.event_id)),
              );
            } catch {
              /* backfill is best-effort; anything missed stays reachable via fetchRecent catch-up */
            }
            for (const e of recovered) {
              lastDelivered = e.event_id;
              this.deliver(roomId, topic, e, handler);
            }
          }
          for (const e of events) {
            if (!this.belongs(e, topic)) continue;
            lastDelivered = e.event_id;
            this.deliver(roomId, topic, e, handler);
          }
        } catch (err) {
          if (this.isStale(generation)) break;
          consecutiveFailures++;
          reportSyncFailure(topic, consecutiveFailures, err);
          await delay(syncRetryDelayMs(consecutiveFailures));
          continue;
        }
        if (returnedTooFast(started, this.syncTimeoutMs)) await delay(SYNC_IDLE_PACE_MS);
      }
    };
    // Keep the catch on this fire-and-forget call, so that anything the ladder inside `loop` does
    // not already contain reaches the operator as a dead live path instead of an unhandled
    // rejection, which under Node's default takes the whole bridge down with it.
    void loop().catch((err: unknown) => reportLoopCrash(topic, err));
  }

  /** True once work started under `generation` must stand down: we disconnected, or reconnected. */
  private isStale(generation: number): boolean {
    return this.stopped || this.generation !== generation;
  }

  /** Wake every native long-poll waiter parked on `roomId` for `topic` (idempotent per waiter). */
  private wakeRoomWaiters(roomId: string, topic: Topic): void {
    const set = this.waiters.get(roomId);
    if (set === undefined) return;
    for (const waiter of [...set]) {
      if (waiter.topic === topic) waiter.wake();
    }
  }

  /** Build the `/sync` room filter with a given timeline limit (0 = no history at all). */
  private syncFilter(roomId: string, timelineLimit: number) {
    return {
      room: {
        rooms: [roomId],
        timeline: { limit: timelineLimit },
        ephemeral: { limit: 0 },
        account_data: { limit: 0 },
        state: { limit: 0, lazy_load_members: true },
      },
      presence: { limit: 0 },
      account_data: { limit: 0 },
    };
  }

  /**
   * Page the timeline BACKWARDS from a `limited` sync's `prev_batch` (`dir=b`, newest→oldest),
   * collecting belonging messages until we reach the last event already delivered (`stopAfter`), the
   * chunk empties, or the page bound trips; return them reversed to ASCENDING order for in-order
   * delivery. `skip` holds the ids already present in the current sync batch so a token-boundary
   * overlap can't double-deliver.
   */
  private async backfill(
    roomId: string,
    topic: Topic,
    prevBatch: string,
    stopAfter: string | undefined,
    skip: Set<unknown>,
  ): Promise<MessageEvent[]> {
    const recovered: MessageEvent[] = [];
    let from = prevBatch;
    const generation = this.generation;
    for (let page = 0; page < MAX_BACKFILL_PAGES && !this.isStale(generation); page++) {
      const res = await this.http(
        'GET',
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/messages?from=${encodeURIComponent(from)}&dir=b&limit=${INCREMENTAL_TIMELINE_LIMIT}`,
      );
      const { chunk, end } = (await res.json()) as { chunk: MatrixEvent[]; end?: string };
      if (chunk.length === 0) break;
      let reachedBoundary = false;
      for (const e of chunk) {
        if (stopAfter !== undefined && e.event_id === stopAfter) {
          reachedBoundary = true;
          break;
        }
        if (skip.has(e.event_id)) continue; // already in this sync's batch — don't double-deliver.
        if (this.belongs(e, topic)) recovered.push(e);
      }
      if (reachedBoundary || end === undefined) break;
      from = end;
    }
    return recovered.reverse();
  }

  /**
   * Hand one event to a subscribe handler and wake the long-polls parked on its room. Keep waking
   * here rather than at the call sites, so that a delivery path added later cannot forget to.
   */
  private deliver(roomId: string, topic: Topic, e: MessageEvent, handler: MessageHandler): void {
    const message = eventToMessage(topic, e);
    try {
      handler(message);
    } catch {
      /* handler is best-effort; never break the loop (DESIGN §6) */
    }
    this.wakeRoomWaiters(roomId, topic);
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }

  /**
   * True iff event `e` is an `m.room.message` belonging to `topic` (tag-gated in shared mode, where
   * the tag is forgeable — see the security note on {@link MatrixBackendConfig.shared_room}).
   */
  private belongs(e: MatrixEvent, topic: Topic): e is MessageEvent {
    if (!isMessageEvent(e)) return false;
    if (this.sharedLocalpart === undefined) return true; // per-topic room: every message is ours
    return contentOf(e)[TOPIC_KEY] === topic;
  }

  /** In shared mode all topics collapse onto one room → one cache key, one resolve. */
  private roomKey(topic: Topic): string {
    // Keep this an escape, never a literal NUL byte, so that the file stays text to file(1) and
    // greppable by ripgrep.
    return this.sharedLocalpart !== undefined ? '\u0000shared' : (topic as string);
  }

  private roomLocalpart(topic: Topic): string {
    return this.sharedLocalpart ?? boundedLocalpart(topic, this.serverName);
  }

  /** Resolve (or create) the room for `topic`, memoized so concurrent first-posts don't double-create. */
  private ensureRoom(topic: Topic): Promise<string> {
    const key = this.roomKey(topic);
    const existing = this.rooms.get(key);
    if (existing !== undefined) return existing;
    const pending = this.resolveOrCreateRoom(this.roomLocalpart(topic)).catch((err) => {
      // Don't poison the cache on transient failure — let the next call retry.
      this.rooms.delete(key);
      throw err;
    });
    this.rooms.set(key, pending);
    return pending;
  }

  /**
   * The room for `topic` if its alias already resolves, else `undefined`. Keep every READ path on
   * this rather than {@link ensureRoom}, so that a topic name chosen by an untrusted inbound message
   * cannot spend the homeserver's per-user room-creation budget (Synapse: ~2-room burst, then ~1
   * room / 45s) and starve the `post` that legitimately needs it.
   */
  private async existingRoom(topic: Topic, generation: number): Promise<string | undefined> {
    const key = this.roomKey(topic);
    const cached = this.rooms.get(key);
    if (cached !== undefined) return cached;
    if (this.isStale(generation)) return undefined;
    const alias = this.aliasOf(this.roomLocalpart(topic));
    const roomId = await this.lookupAlias(alias);
    // Keep a gate on BOTH sides of the join, so that a teardown landing mid-resolve or mid-JOIN can
    // neither talk to the homeserver with a cleared token nor repopulate {@link rooms} for the next
    // generation.
    if (roomId === undefined || this.isStale(generation)) return undefined;
    await this.joinRoom(roomId, alias);
    if (this.isStale(generation)) return undefined;
    this.rooms.set(key, Promise.resolve(roomId));
    return roomId;
  }

  /**
   * {@link existingRoom}, re-polled until `deadline`. Keep the wait, so that a blocking read on a
   * topic whose first message has not landed yet still waits for the peer's `post` to provision the
   * room instead of returning instantly and turning an agent's long-poll into a spin. Keep it gated
   * on `generation` and interruptible, so that the poll stands down AT the `disconnect()` rather
   * than one `sync_timeout_ms` later — and never under the next `connect()`.
   */
  private async roomForRead(
    topic: Topic,
    deadline: number,
    generation: number,
  ): Promise<string | undefined> {
    for (;;) {
      if (this.isStale(generation)) return undefined;
      const roomId = await this.existingRoom(topic, generation);
      if (roomId !== undefined) return roomId;
      const remaining = deadline - Date.now();
      if (remaining <= 0) return undefined;
      await this.interruptibleDelay(this.parkSlice(remaining));
    }
  }

  /** How long a park may sleep before it re-queries: never past `remaining`, never below the floor. */
  private parkSlice(remaining: number): number {
    return Math.min(remaining, Math.max(this.syncTimeoutMs, MIN_PARK_SLICE_MS));
  }

  /** Sleep, but no longer than the next `disconnect()` (which aborts every registered controller). */
  private async interruptibleDelay(ms: number): Promise<void> {
    const controller = new AbortController();
    this.controllers.add(controller);
    try {
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, ms);
        controller.signal.addEventListener(
          'abort',
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    } finally {
      this.controllers.delete(controller);
    }
  }

  private aliasOf(localpart: string): string {
    return `#${localpart}:${this.serverName}`;
  }

  private async resolveOrCreateRoom(localpart: string): Promise<string> {
    const alias = this.aliasOf(localpart);
    const existing = await this.lookupAlias(alias);
    if (existing !== undefined) {
      await this.joinRoom(existing, alias);
      return existing;
    }
    // Create. If we lost the race (another instance created it first), resolve the alias instead.
    // SEC: `visibility: 'private'` only hides the room from the directory — the JOIN RULE is what
    // keeps an uninvited account off a guessable alias, and that comes from `preset` alone.
    const res = await this.http('POST', '/_matrix/client/v3/createRoom', {
      body: {
        room_alias_name: localpart,
        preset: this.roomPreset,
        visibility: 'private',
        ...(this.invite.length > 0 ? { invite: this.invite } : {}),
      },
      allowStatuses: [400, 409],
    });
    if (res.ok) {
      const json = (await res.json()) as { room_id: string };
      return json.room_id;
    }
    // M_ROOM_IN_USE (or alias taken) → resolve the now-existing alias.
    const raced = await this.lookupAlias(alias);
    if (raced !== undefined) {
      await this.joinRoom(raced, alias);
      return raced;
    }
    const body = await res.text();
    throw new Error(`createRoom failed (${res.status}) and alias unresolved: ${body}`);
  }

  private async lookupAlias(alias: string): Promise<string | undefined> {
    const res = await this.http(
      'GET',
      `/_matrix/client/v3/directory/room/${encodeURIComponent(alias)}`,
      { allowStatuses: [404] },
    );
    if (!res.ok) return undefined;
    const json = (await res.json()) as { room_id: string };
    return json.room_id;
  }

  /**
   * Join `roomId` (idempotent — 200 with the room_id even when already joined). Keep the 403 a
   * THROW, so that an account this room never invited fails here, naming the fix, instead of
   * "succeeding" and surfacing later as an opaque 403 out of `/send` and `/messages` — or, on the
   * live path, as a `/sync` that simply never yields the room.
   */
  private async joinRoom(roomId: string, alias: string): Promise<void> {
    const res = await this.http(
      'POST',
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/join`,
      { body: {}, allowStatuses: [403] },
    );
    if (res.status === 403) {
      throw new Error(
        `Matrix join refused (403) for ${alias} (${roomId}) as ` +
          `${this.userId ?? this.user}: the room admits only invited members. Add this account to ` +
          "the creating config's backend_config.invite, or have a member of the room invite it.",
      );
    }
  }

  /**
   * Single HTTP entry point. Adds auth, JSON encodes, and transparently retries on 429
   * (`M_LIMIT_EXCEEDED`) honoring `retry_after_ms`. Retries stop the moment we disconnect, so an
   * aborted test never leaves a loop hammering the homeserver. Throws on unexpected non-2xx unless
   * the caller marks the status as expected via `allowStatuses`.
   */
  private async http(
    method: string,
    path: string,
    opts?: {
      body?: unknown;
      signal?: AbortSignal;
      allowStatuses?: number[];
      deadlineMs?: number;
    },
  ): Promise<Response> {
    const generation = this.generation;
    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {};
    if (this.token !== undefined) headers.Authorization = `Bearer ${this.token}`;
    if (opts?.body !== undefined) headers['Content-Type'] = 'application/json';

    return fetchWithRetry(
      url,
      {
        method,
        headers,
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: opts?.signal,
      },
      {
        label: `Matrix ${method} ${path}`,
        // Stop retrying once disconnected — don't compete for the rate-limit budget post-teardown.
        isStopped: () => this.isStale(generation),
        retryAfterOf: readRetryAfter,
        allowStatuses: opts?.allowStatuses,
        deadlineMs: opts?.deadlineMs,
      },
    );
  }
}

/**
 * The `event_id` of the newest event a positioning `/sync` snapshot carries (ANY type — a state
 * event is a valid boundary since `backfill` matches by id, not by topic/type), or `undefined` for a
 * room with no timeline history.
 */
const timelineTipOf = (sync: SyncResponse, roomId: string): string | undefined => {
  const tip = sync.rooms?.join?.[roomId]?.timeline?.events?.at(-1)?.event_id;
  return typeof tip === 'string' ? tip : undefined;
};

interface SyncResponse {
  next_batch?: string;
  rooms?: {
    join?: Record<
      string,
      { timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string } }
    >;
  };
}

/**
 * Normalize an untrusted timeline event into a {@link Message}. Every field a room member controls
 * is coerced rather than trusted: a non-string `body` reaches core's mention parser, and a
 * non-numeric `origin_server_ts` reaches `Date#toISOString`, either of which throws — and a throw
 * out of `fetchRecent` bricks startup catch-up on every subsequent restart.
 */
function eventToMessage(topic: Topic, e: MessageEvent): Message {
  const body = contentOf(e).body;
  return buildMessage({
    topic,
    sender: typeof e.sender === 'string' ? e.sender : '',
    content: typeof body === 'string' ? body : '',
    timestamp: isoTimestamp(e.origin_server_ts),
    id: e.event_id,
  });
}

/** Largest offset `Date` can represent; past it `toISOString()` throws a RangeError. */
const MAX_TIMESTAMP_MS = 8.64e15;

const isoTimestamp = (ts: unknown): string =>
  new Date(
    typeof ts === 'number' && Number.isFinite(ts) && Math.abs(ts) <= MAX_TIMESTAMP_MS ? ts : 0,
  ).toISOString();

/**
 * The cursor a forward page must report: the last belonging message's, else the last FULL raw
 * page's position so a page-sized block of foreign-topic or non-message events is crossed rather
 * than replayed forever, else the input `since` — which is what a short, all-foreign tail must
 * report, so that traffic on another topic never moves this topic's cursor.
 */
const cursorPastForeignBlock = (
  collected: Message[],
  lastRawEventId: string | undefined,
  sinceCursor: Cursor,
): Cursor =>
  collected.at(-1)?.cursor ??
  (lastRawEventId !== undefined ? asCursor(lastRawEventId) : sinceCursor);

/**
 * Matrix 429s carry `retry_after_ms` (MS) in the JSON body; Synapse ALSO sends the standard
 * `Retry-After` header (both RFC 9110 forms). Prefer the header, then the body. Returned UNCLAMPED
 * and `undefined` when there is no usable hint, so that we never retry sooner than the homeserver
 * asked — that is what escalates a rate limit into a ban — and the default plus the ceiling stay in
 * net-util rather than being re-tuned here.
 */
export async function readRetryAfter(res: Response): Promise<number | undefined> {
  const header = retryAfterFromHeader(res);
  if (header !== undefined) return header;
  try {
    const json = (await res.clone().json()) as { retry_after_ms?: number };
    const ms = json.retry_after_ms;
    if (typeof ms === 'number' && ms > 0) return ms;
  } catch {
    /* no usable body hint */
  }
  return undefined;
}

const rand = (): string => Math.random().toString(36).slice(2, 10);

/** Live-coverage key: a subscribe loop covers exactly the (room, topic) pair it delivers. */
const liveKey = (roomId: string, topic: Topic): string => `${roomId}\u0000${String(topic)}`;

/** Ceiling on the subscribe loop's retry backoff — a dead homeserver still gets re-probed. */
const SYNC_RETRY_MAX_MS = 30_000;

/**
 * Exponential backoff for a failing `/sync`, so a PERMANENT failure (revoked token → 401, kicked
 * from the room → 403) degrades to a slow probe instead of hammering the homeserver forever.
 */
const syncRetryDelayMs = (consecutiveFailures: number): number =>
  Math.min(200 * 2 ** (consecutiveFailures - 1), SYNC_RETRY_MAX_MS);

/**
 * Announce a failing subscribe loop on stderr — otherwise a permanently broken live path is
 * invisible to the operator, who sees only homeserver load. Rate-limited to powers of two so a
 * long outage cannot itself become the flood.
 */
function reportSyncFailure(topic: Topic, consecutiveFailures: number, err: unknown): void {
  if ((consecutiveFailures & (consecutiveFailures - 1)) !== 0) return;
  // Drop the query string: a `/sync` URL carries the whole JSON room filter, which buries the
  // status and error body an operator actually needs under a screenful of percent-encoding.
  const detail = (err instanceof Error ? err.message : String(err)).replace(/\?\S*?(?= →|$)/, '');
  console.error(
    `[parley-matrix] /sync failed for topic ${JSON.stringify(String(topic))} ` +
      `(${consecutiveFailures} consecutive; retrying in ${syncRetryDelayMs(consecutiveFailures)}ms): ${detail}`,
  );
}

/**
 * The resume token a `/sync` response advances to. Keep a non-string a THROW rather than adopting or
 * ignoring it, so that a loop cannot resume from a token the homeserver will reject — or, on a
 * server whose tokens are ordinal, silently seek past unread events — and instead reports and backs
 * off from the last token that worked.
 */
const nextBatchOf = (raw: unknown, current: string): string => {
  if (raw === undefined) return current;
  if (typeof raw !== 'string') {
    throw new Error(`/sync answered with a ${typeof raw} next_batch where a token was required`);
  }
  return raw;
};

/**
 * Announce a `/sync` loop that ended on something its own retry ladder did not contain — the live
 * path for this topic is gone until the next `subscribe`, and only `fetchRecent` catch-up still
 * reads it.
 */
function reportLoopCrash(topic: Topic, err: unknown): void {
  console.error(
    `[parley-matrix] the /sync loop for topic ${JSON.stringify(String(topic))} ended on an ` +
      `unexpected error; live delivery for it has stopped: ` +
      `${err instanceof Error ? (err.stack ?? err.message) : String(err)}`,
  );
}

/**
 * Matrix alias localparts allow a restricted character set; map anything else to `_`. Exported so
 * that this package's tests — and its fake homeserver's alias directory — grade THIS fold rather
 * than a hand-copy of it: two topics folding onto one localpart share a room and cross-deliver, and
 * {@link safeName} is what keeps the fold injective.
 *
 * Keep the output ASCII, so that {@link boundedLocalpart} may count its length limit in characters.
 */
export const sanitizeAlias = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** Bytes Matrix allows in a room alias, `#` and `:<server_name>` included. */
const MAX_ALIAS_BYTES = 255;

const ALIAS_PREFIX = 'parley_';

/**
 * The alias localpart for `topic`, bounded so `#<localpart>:<server_name>` stays inside
 * {@link MAX_ALIAS_BYTES}. Past that the homeserver refuses `createRoom` with a 400 naming neither
 * the topic nor this plugin, while every read of the same topic returns the empty page a
 * never-written topic returns — so the topic silently never works. An over-long name keeps a digest
 * of the whole raw topic ({@link MIN_HASH_LEN} wide, as {@link safeName} mints) and truncates only
 * the readable half, so the fold stays injective.
 */
function boundedLocalpart(topic: Topic, serverName: string): string {
  const budget = MAX_ALIAS_BYTES - Buffer.byteLength(`#:${serverName}`, 'utf8');
  const name = `${ALIAS_PREFIX}${safeName(topic, sanitizeAlias)}`;
  if (name.length <= budget) return name;
  const keep = budget - ALIAS_PREFIX.length - 1 - MIN_HASH_LEN;
  if (keep < 1) {
    throw new Error(
      `[parley-matrix] backend_config.server_name ${JSON.stringify(serverName)} leaves no room ` +
        `for a distinct alias localpart: #<localpart>:<server_name> must fit ${MAX_ALIAS_BYTES} ` +
        `bytes, and topic ${JSON.stringify(String(topic))} needs at least ` +
        `${ALIAS_PREFIX.length + 1 + MIN_HASH_LEN + 1} of them. Use a shorter server_name.`,
    );
  }
  const digest = createHash('sha1')
    .update(String(topic), 'utf8')
    .digest('hex')
    .slice(0, MIN_HASH_LEN);
  return `${ALIAS_PREFIX}${sanitizeAlias(String(topic)).slice(0, keep)}-${digest}`;
}
