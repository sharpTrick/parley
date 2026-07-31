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
import { client } from '@xmpp/client';
import { randomBytes, randomUUID } from 'node:crypto';

import {
  DEFAULT_PASSWORD,
  DEFAULT_SERVICE,
  validateBackendConfig,
  warnInsecureConfig,
} from './config.js';
import * as jid from './jid.js';
import * as wire from './stanzas.js';

export { CONFIG_KEYS, isPlaintextRemote, JID_SIZED_KEYS, validateBackendConfig } from './config.js';
export type { XmppBackendConfig } from './config.js';
export { JID_PART_MAX_BYTES } from './jid.js';

const JOIN_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MS = 15_000;
const MAM_TIMEOUT_MS = 15_000;
const DISCO_TIMEOUT_MS = 5_000;
/** Default RSM page size for forward MAM paging (`backend_config.mam_page` overrides). */
const MAM_PAGE = 200;
/** First archival-lag re-poll interval after a live-message wake; it doubles on each miss. */
const MAM_LAG_POLL_MS = 50;
/** Floor between two stream-error reports, so a reconnect storm can't flood stderr. */
const STREAM_ERROR_LOG_MS = 5_000;
/** First wait before re-entering a room whose occupancy ended remotely; doubles per repeat loss. */
const REJOIN_BASE_MS = 200;
/** Consecutive losses, each within {@link REJOIN_WINDOW_MS} of the last, after which the room is
 * left alone. */
const REJOIN_LIMIT = 6;
/** Occupancy held this long counts as recovered: the consecutive-loss count starts over. */
const REJOIN_WINDOW_MS = 60_000;
/** Longest wait the {@link REJOIN_LIMIT}-step ladder can produce, jitter excluded. */
export const REJOIN_MAX_WAIT_MS = REJOIN_BASE_MS * 2 ** (REJOIN_LIMIT - 1);
const JOIN_RETRIES = 8;
/** Conditions that mean "room not committed yet" — retryable during concurrent cold-start. */
const RETRYABLE_CONDITIONS = ['item-not-found', 'recipient-unavailable', 'remote-server-not-found'];
/**
 * Bounce conditions that mean this connection is no longer an occupant of the room it addressed:
 * occupancy can end without the stream dropping, and the join cache would otherwise hold a resolved
 * promise for a room we are not in.
 */
const NOT_AN_OCCUPANT_CONDITIONS = ['not-acceptable', 'gone', 'item-not-found', 'recipient-unavailable'];

const MAM_MISSING_HINT =
  'this backend needs XEP-0313 MAM for MUC — enable mod_mam + muc_mam (Prosody) or mod_mam ' +
  '(ejabberd); without an archive there is no cursor, no catch-up and no live delivery';

// Correlators (origin-id, nick) are published in the room on every post, so a co-occupant sees
// them: keep this crypto-random, or an observer can predict the next one and race the reflection.
const rand = (): string => randomBytes(8).toString('hex');

interface PendingJoin {
  /** The nick this join's presence was addressed to; only a presence naming it (or one carrying
   * XEP-0045 status 210) can be attributed to it. */
  nick: string;
  resolve(): void;
  reject(err: Error): void;
  /** Hand this entry's outcome to a successor join for the same room ({@link XmppPlugin.joinOnce}). */
  settleFrom(outcome: Promise<void>): void;
}
interface PendingPost {
  /** The room this post was sent to; only its own reflection may resolve the correlator. */
  room: string;
  resolve(id: BackendMsgId): void;
  reject(err: Error): void;
}
/** One archive window: the rows the seam carries, and where in the archive the read actually got to. */
interface ReadWindow {
  items: wire.BodiedItem[];
  /** Archive id of the last row the read SAW, admitted or not; `undefined` when it saw none. */
  tail?: string;
}
/** Why a long-poll waiter woke: only `message` implies the archive may still be lagging. */
type WakeReason = 'message' | 'timeout' | 'cancel';

/**
 * XMPP MUC backend (DESIGN §6/§9). A topic maps to a MUC room; the per-message XEP-0359 stanza-id
 * (== XEP-0313 MAM archive id) is a stable, server-assigned, per-room-monotonic value used as BOTH
 * `backendMsgId` (dedup key) and `cursor` (order key). `post` resolves on the MUC's own reflection
 * (carrying that stanza-id); `fetchRecent` is a MAM query with RSM `<after>` (exclusive `since`);
 * `subscribe` delivers every reflected groupchat message carrying a room stanza-id.
 *
 * Catch-up REQUIRES server-side MAM (mod_mam + muc_mam); without it the room has no archive and
 * `fetchRecent` returns nothing. Core never compares cursor values — the server's RSM `<after>`
 * defines "strictly after"; the archive defines order.
 */
export class XmppPlugin implements BackendPlugin {
  private xmpp?: wire.XmppClient;
  private mucService = 'muc.parley.local';
  private handle = 'parley';
  private nick = `parley-${rand()}`;
  /** The fallback for a nick another occupant already holds; `undefined` when config pinned one. */
  private provisionalNick?: string;
  private mamPage = MAM_PAGE;
  private stopped = false;
  private lastStreamErrorAt = 0;
  /** Settled once the occupant nick is final: pinned by config, or taken from `post`'s identity. */
  private nickAdoption?: Promise<void>;
  /** The nick taken from the FIRST post's identity; `undefined` when config pinned one instead. */
  private adoptedNick?: string;
  /** The nick a room last ADMITTED this connection under, which is not always the one it asked for. */
  private admittedNick?: string;
  private identityCollapseReported = false;
  /** Memoized disco#info probe for the one prerequisite this backend cannot work without. */
  private mamCheck?: Promise<void>;

  /** roomJid -> in-flight/settled join (cached like an "ensure"; idempotent). */
  private readonly joined = new Map<string, Promise<void>>();
  /**
   * roomJid -> the occupant nick this connection actually holds there, once it differs from
   * {@link nick}. Keyed per room, so that one room's nick cannot make this connection's reflections
   * in every OTHER room fail the provenance check in {@link onGroupchat} and stall every post there.
   */
  private readonly roomNicks = new Map<string, string>();
  /** roomJid -> consecutive remote occupancy losses and the deferred re-entry they scheduled. */
  private readonly rejoins = new Map<
    string,
    { losses: number; at: number; timer?: ReturnType<typeof setTimeout> }
  >();
  private readonly pendingJoins = new Map<string, PendingJoin>();
  /** origin-id -> resolver awaiting the MUC reflection that carries the archive id. */
  private readonly pendingPosts = new Map<string, PendingPost>();
  /** MAM queryid -> collector for the streamed `<result>` items, bound to the room queried. */
  private readonly mamCollectors = new Map<string, { room: string; items: wire.MamItem[] }>();
  /** roomJid -> live subscription(s). */
  private readonly subscriptions = new Map<string, { topic: Topic; handlers: MessageHandler[] }>();
  /**
   * Long-poll wakeups: roomJid -> one-shot callbacks armed by a blocking `fetchRecent`. Independent
   * of `subscriptions` — a blocking fetch listens on the live MUC delivery the push path already
   * runs, it does not subscribe or join twice.
   */
  private readonly waiters = new Map<string, Set<(reason: WakeReason) => void>>();

  async connect(config: BackendConfig): Promise<void> {
    if (this.xmpp !== undefined) {
      throw new Error(
        'parley-xmpp: already connected — call disconnect() before connect() again. Taking the ' +
          'second client would abandon the first, which goes on redialling with ' +
          'backend_config.password while its stanza handlers still drive this plugin.',
      );
    }
    const cfg = validateBackendConfig(config);
    this.mucService = cfg.muc_service ?? 'muc.parley.local';
    const username = cfg.username ?? 'parley';
    this.handle = username;
    this.nick = cfg.nick ?? `${username}-${rand()}`;
    this.provisionalNick = cfg.nick === undefined ? this.nick : undefined;
    this.mamPage = cfg.mam_page ?? MAM_PAGE;
    this.stopped = false;
    this.nickAdoption = cfg.nick === undefined ? undefined : Promise.resolve();
    this.adoptedNick = undefined;
    this.admittedNick = undefined;
    this.identityCollapseReported = false;
    this.mamCheck = undefined;

    const service = cfg.service ?? DEFAULT_SERVICE;
    warnInsecureConfig(service, cfg.password);

    const xmpp = client({
      service,
      domain: cfg.domain ?? 'parley.local',
      username,
      password: cfg.password ?? DEFAULT_PASSWORD,
    }) as unknown as wire.XmppClient;
    // Report on stderr, NEVER stdout, so that cli.ts's JSON-RPC channel stays parseable.
    xmpp.on('error', (err) => this.reportStreamError(err));
    xmpp.on('stanza', (stanza) => this.onStanza(stanza as wire.El));
    let firstOnline = true;
    xmpp.on('online', () => {
      if (firstOnline) {
        firstOnline = false;
        return;
      }
      this.rejoinAfterReconnect();
    });
    // `@xmpp/reconnect` is listening from the moment the client is constructed, so keep the stop on
    // the failure path: a client this call abandons goes on redialling — re-presenting `password`
    // to a server the caller believes it never reached — with nothing left holding a handle on it.
    try {
      await xmpp.start();
    } catch (err) {
      await xmpp.stop().catch(() => undefined);
      throw err;
    }
    this.xmpp = xmpp;
  }

  async disconnect(): Promise<void> {
    this.stopped = true;
    for (const pj of this.pendingJoins.values()) pj.reject(new Error('disconnecting'));
    this.pendingJoins.clear();
    for (const pp of this.pendingPosts.values()) pp.reject(new Error('disconnecting'));
    this.pendingPosts.clear();
    this.mamCollectors.clear();
    this.subscriptions.clear();
    // Abort every in-flight long-poll cleanly (each fire clears its own timer + de-registers), so a
    // blocked fetch wakes, sees `stopped`, and returns an empty page — no leaked listeners/timers.
    for (const set of [...this.waiters.values()]) for (const fire of [...set]) fire('cancel');
    this.waiters.clear();
    this.forgetAllRooms();
    for (const state of this.rejoins.values()) clearTimeout(state.timer);
    this.rejoins.clear();
    this.mamCheck = undefined;
    if (this.xmpp !== undefined) {
      await this.xmpp.stop().catch(() => undefined);
      this.xmpp = undefined;
    }
  }

  /**
   * `<message type='groupchat'>` into the topic's room, resolved by the MUC's own reflection (which
   * carries the archive id). The sender on the wire is this connection's MUC nick, which unless
   * pinned by config is taken from `identity` on the first post ({@link adoptIdentityNick}).
   * `opts.inReplyTo` is IGNORED: XEP-0461 replies exist, but nothing this seam returns carries the
   * relation back, so it is documented as dropped rather than half-implemented (README).
   */
  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    wire.assertXmlSafe(content, 'post content');
    await this.adoptIdentityNick(identity);
    const room = this.roomJid(topic);
    await this.ensureJoinedRoom(room);
    const conn = this.require();
    const originId = `o-${randomUUID()}`;

    const promise = new Promise<BackendMsgId>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPosts.delete(originId);
        reject(new Error(`post reflection timeout in ${room}`));
      }, POST_TIMEOUT_MS);
      this.pendingPosts.set(originId, {
        room,
        resolve: (id) => {
          clearTimeout(timer);
          resolve(id);
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
    });

    // Keep a failed send settling the correlator instead of escaping past it, so that the caller
    // holds the ONE promise this call made: an abandoned correlator rejects on its own timer, on a
    // disconnect or on a reconnect with nothing holding it, and Node kills the process for it.
    try {
      await conn.send(wire.groupchatMessage(room, originId, content));
    } catch (err) {
      const pending = this.pendingPosts.get(originId);
      this.pendingPosts.delete(originId);
      pending?.reject(wire.asError(err));
    }
    return promise;
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const since = args.since === undefined ? undefined : String(args.since);
    if (!(await this.roomExists(args.topic))) {
      return { messages: [], nextCursor: args.since ?? asCursor('') };
    }
    await this.ensureJoinedRoom(this.roomJid(args.topic));
    const limit = args.limit ?? 100;

    let window = await this.readWindow(args.topic, since, limit);
    const blockMs = Math.floor(args.blockMs ?? 0);
    if (window.items.length === 0 && blockMs > 0) {
      window = await this.blockingMam(args.topic, since, limit, blockMs, window);
    }

    const messages = window.items.map((it) => this.toMessage(args.topic, it));
    // Keep an EMPTY page's cursor on the window's unfiltered tail, so that a window of nothing but
    // stanzas the seam drops advances past them instead of reporting '' — the zero cursor, which
    // asks for this room's archive from message one. Keep a page that DID carry rows on its own last
    // row, so that a truncated page cannot skip what it withheld (conformance grades it).
    const nextCursor =
      messages.at(-1)?.cursor ??
      (window.tail === undefined ? (args.since ?? asCursor('')) : asCursor(window.tail));
    return { messages, nextCursor };
  }

  /**
   * The window `args` asks for: the most recent `limit` (RSM "last page" via an empty `<before/>`)
   * when no cursor was given, otherwise everything strictly after it. `blockMs` re-reads THIS, so
   * that the argument changes when a fetch returns and never which window it returns.
   */
  private async readWindow(
    topic: Topic,
    since: string | undefined,
    limit: number,
  ): Promise<ReadWindow> {
    if (since === undefined) {
      const page = await this.mamQuery(topic, { lastPage: true, max: limit });
      return { items: page.items.filter(wire.hasBody), tail: page.items.at(-1)?.archId };
    }
    return this.exclusiveMam(topic, since, limit);
  }

  /**
   * Forward, exclusive MAM catch-up strictly after `since`, paged up to `limit`. `since === ''` (the
   * empty archive's zero cursor) means "from the very beginning": the first page omits `<after/>`
   * (guarded in {@link wire.mamQueryIq}), later pages advance on real archive ids.
   *
   * Keep the page's UNFILTERED tail as the next `<after/>` and the loop's stop condition, so that a
   * page of items the seam does not carry advances past them; filtering first reads as "archive
   * exhausted" and withholds everything behind them forever.
   *
   * Keep the strict-advance check too: every other exit is the SERVER declaring progress, so a peer
   * that answers `<after>X</after>` with a page tailed by X again spins here forever, inside a seam
   * call nothing above times out.
   */
  private async exclusiveMam(topic: Topic, since: string, limit: number): Promise<ReadWindow> {
    const items: wire.BodiedItem[] = [];
    let cursor = since;
    let tail: string | undefined;
    while (items.length < limit) {
      const page = await this.mamQuery(topic, {
        after: cursor,
        max: Math.min(this.mamPage, limit - items.length),
      });
      items.push(...page.items.filter(wire.hasBody));
      const pageTail = page.items.at(-1)?.archId;
      if (pageTail !== undefined) tail = pageTail;
      if (page.complete || pageTail === undefined) break;
      if (pageTail === cursor) {
        throw new Error(
          `MAM paging on ${this.roomJid(topic)} did not advance: the page after '${cursor}' ends ` +
            'at that same archive id and is not marked complete, so catch-up cannot make progress',
        );
      }
      cursor = pageTail;
    }
    return { items, tail };
  }

  /**
   * Native long-poll: MUC-live-wait + MAM-reconcile. Each round REGISTERS the room waiter before
   * re-reading {@link readWindow}, so that a message reflected during the query's round trip fires
   * an already-registered waiter instead of firing into the void; its park timer only starts once
   * the query is back, so the park is the interval asked for rather than what a slow server left of
   * it. An empty return is safe: it carries the last window read, whose cursor never precedes `since`.
   *
   * Once a live message has been seen the archive is known to be behind the stream, so the re-poll
   * interval DOUBLES from {@link MAM_LAG_POLL_MS} instead of expiring back to the whole remaining
   * budget — which would withhold a message already in the archive until `blockMs` ran out.
   */
  private async blockingMam(
    topic: Topic,
    since: string | undefined,
    limit: number,
    blockMs: number,
    firstRead: ReadWindow,
  ): Promise<ReadWindow> {
    const deadline = Date.now() + blockMs;
    const room = this.roomJid(topic);
    let latest = firstRead;
    let lagPoll = 0;
    for (;;) {
      if (this.stopped || Date.now() >= deadline) return latest;
      const waiter = this.armWaiter(room);
      try {
        latest = await this.readWindow(topic, since, limit);
        if (latest.items.length > 0 || this.stopped) return latest;
        const budget = deadline - Date.now();
        const park = lagPoll > 0 ? Math.min(budget, lagPoll) : budget;
        if (park <= 0) return latest;
        const reason = await waiter.park(park);
        if (reason === 'message') lagPoll = MAM_LAG_POLL_MS;
        else if (reason === 'timeout' && lagPoll > 0) lagPoll *= 2;
      } catch (err) {
        if (this.stopped) return latest;
        throw err;
      } finally {
        waiter.cancel();
      }
    }
  }

  /**
   * Register a one-shot long-poll waiter on `room`: it resolves on a live groupchat message for
   * that room ({@link fireWaiters}), on the `park(ms)` timer, or on `disconnect()`. `park` may be
   * called after the waiter has already fired, and then arms no timer; `cancel()` — also the fire
   * path — is idempotent and clears the timer and the registration.
   */
  private armWaiter(room: string): {
    park: (ms: number) => Promise<WakeReason>;
    cancel: () => void;
  } {
    let resolveFired!: (reason: WakeReason) => void;
    const fired = new Promise<WakeReason>((r) => {
      resolveFired = r;
    });
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = (reason: WakeReason): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const set = this.waiters.get(room);
      if (set !== undefined) {
        set.delete(fire);
        if (set.size === 0) this.waiters.delete(room);
      }
      resolveFired(reason);
    };
    let set = this.waiters.get(room);
    if (set === undefined) {
      set = new Set();
      this.waiters.set(room, set);
    }
    set.add(fire);
    return {
      park: (ms) => {
        if (!settled) timer = setTimeout(() => fire('timeout'), ms);
        return fired;
      },
      cancel: () => fire('cancel'),
    };
  }

  /** Wake every long-poll fetch blocked on `room`; each fire self-clears (idempotent). */
  private fireWaiters(room: string): void {
    const set = this.waiters.get(room);
    if (set !== undefined) for (const fire of [...set]) fire('message');
  }

  async subscribe(topic: Topic, handler: MessageHandler): Promise<void> {
    const room = this.roomJid(topic);
    await this.ensureJoinedRoom(room);
    const existing = this.subscriptions.get(room);
    if (existing !== undefined) {
      existing.handlers.push(handler);
    } else {
      this.subscriptions.set(room, { topic, handlers: [handler] });
    }
  }

  /**
   * A handle's backend-native name is the MUC nick its posts are read back under. One connection is
   * one occupant, so once this connection's nick is settled — pinned by config, taken from the first
   * post's identity, or reverted after a `conflict` — that nick is the sender of every handle's
   * posts, and answering the per-handle {@link jid.nickFor} fold would name someone no message in any
   * room carries. Before the first post the nick is open, and the fold is what this handle would take.
   *
   * The answer is the nick a room last ADMITTED, not the one asked for: a nick-locking service
   * rewrites it (XEP-0045 status 210) and the archive carries the rewritten name. Occupancy is per
   * room, so a room entered before a `conflict` revert keeps the sender it entered under (README).
   */
  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    const settled = this.nickAdoption !== undefined;
    return { handle, backendRef: settled ? (this.admittedNick ?? this.nick) : jid.nickFor(handle) };
  }

  private reportStreamError(err: unknown): void {
    const now = Date.now();
    if (now - this.lastStreamErrorAt < STREAM_ERROR_LOG_MS) return;
    this.lastStreamErrorAt = now;
    console.error(`[parley-xmpp] stream error: ${wire.asError(err).message}`);
  }

  private onStanza(stanza: wire.El): void {
    if (this.stopped) return;
    if (stanza.is('presence')) {
      this.onPresence(stanza);
      return;
    }
    if (!stanza.is('message')) return;

    const result = stanza.getChild('result', wire.NS_MAM);
    if (result !== undefined) {
      this.onMamResult(result, jid.bareOf(stanza.attrs.from ?? ''));
      return;
    }

    if (stanza.attrs.type === 'error') {
      this.onErrorMessage(stanza);
      return;
    }
    if (stanza.attrs.type !== 'groupchat') return;
    this.onGroupchat(stanza);
  }

  /**
   * A MUC bounce of one of our stanzas (not an occupant, no voice, kicked/banned, room gone). The
   * reflection can never arrive, so fail the correlated post/join NOW with the server's condition
   * instead of burning the full timeout and reporting a causeless stall.
   *
   * A bounce that carries an id settles that post or nothing at all. Keep it from falling through to
   * the room's join, so that a late bounce for an already cleared post cannot reject an unrelated
   * operation with another operation's condition.
   *
   * A service bounce always comes from the BARE room JID (RFC 6120 §8.3). Keep the occupant-resource
   * check, so that a co-occupant's error stanza cannot fail our in-flight joins and posts at will.
   */
  private onErrorMessage(stanza: wire.El): void {
    const from = stanza.attrs.from ?? '';
    if (jid.resourceOf(from) !== '') return;
    const room = jid.bareOf(from);
    const err = wire.stanzaError(stanza);
    const originId = stanza.getChild('origin-id', wire.NS_SID)?.attrs.id ?? stanza.attrs.id ?? '';
    if (originId !== '') {
      const post = this.pendingPosts.get(originId);
      if (post === undefined || post.room !== room) return;
      this.pendingPosts.delete(originId);
      if (NOT_AN_OCCUPANT_CONDITIONS.includes(err.condition)) {
        this.onOccupancyLost(room, wire.describeError(err));
      }
      post.reject(new Error(`post rejected by ${room} (${wire.describeError(err)})`));
      return;
    }
    this.pendingJoins.get(room)?.reject(new wire.JoinError(err.condition, room, err.text));
  }

  private onPresence(stanza: wire.El): void {
    const from = stanza.attrs.from ?? '';
    const room = jid.bareOf(from);
    const resource = jid.resourceOf(from);
    const x = stanza.getChild('x', wire.NS_MUC_USER);
    const statuses = (x?.getChildren('status') ?? []).map((s) => s.attrs.code ?? '');
    const isSelf = resource === this.occupantNick(room) || statuses.includes(wire.STATUS_SELF_PRESENCE);

    if (stanza.attrs.type === 'unavailable') {
      if (isSelf && !statuses.includes(wire.STATUS_NICK_CHANGE)) {
        this.onOccupancyLost(room, wire.occupancyEndReason(statuses, x));
      }
      return;
    }

    const pending = this.pendingJoins.get(room);
    if (stanza.attrs.type === 'error') {
      // Keep an error presence attributed by the nick it names, as the self-presence arm below is,
      // so that a superseded join's refusal cannot fail the successor that is about to succeed —
      // which startPushLoop rethrows — or revert the nick over a name this connection never asked
      // for. A service rewrite (status 210) admits an occupant; it never appears on a refusal.
      if (pending !== undefined && resource !== '' && resource !== pending.nick) return;
      const err = wire.stanzaError(stanza);
      pending?.reject(new wire.JoinError(err.condition, room, err.text));
      return;
    }
    if (!isSelf) return;
    // Status 110 alone does NOT make a self-presence this join's: the answer to a superseded join
    // carries 110 for the nick that join asked for. Attribute it to the nick the pending join was
    // addressed to, or to an explicit service rewrite (XEP-0045 status 210), so that a join is never
    // settled for a nick this connection does not hold — after which its own reflections fail the
    // provenance check and every post stalls to POST_TIMEOUT_MS.
    const assignedByService = statuses.includes(wire.STATUS_SERVICE_ASSIGNED_NICK);
    const addressed = pending?.nick ?? this.occupantNick(room);
    if (resource !== '' && resource !== addressed && !assignedByService) return;
    if (resource !== '') this.admittedNick = resource;
    if (resource !== '' && resource !== this.occupantNick(room)) {
      if (assignedByService) {
        console.error(
          `[parley-xmpp] ${room} assigned this connection the occupant nick '${resource}' instead ` +
            `of '${addressed}'; messages from this bridge in that room are attributed to it`,
        );
      }
      this.roomNicks.set(room, resource);
    }
    if (pending === undefined) return;
    if (statuses.includes(wire.STATUS_ROOM_CREATED)) {
      const unlocked = (): void => pending.resolve();
      void this.configureRoom(room).then(unlocked, unlocked);
    } else {
      pending.resolve();
    }
  }

  /**
   * Occupancy ended without the stream dropping — kicked, banned, room destroyed, MUC component
   * restarted, or a post bounced as "not an occupant". `joined` caches a RESOLVED promise, so without
   * this the plugin would never re-enter the room: push permanently dead in silence and every post
   * bouncing forever. A join still in flight settles on its own.
   *
   * The re-entry is remote-driven, so it is DEFERRED and backs off: a room that ends occupancy on
   * every join (a moderation bot, a members-only toggle, a MUC service shutting down) would
   * otherwise be re-joined as fast as the loop can send presence, one stderr line each. Keep the
   * re-join off the loss path itself, so that a loss delivered from inside a send cannot spin
   * without ever yielding to a timer.
   */
  private onOccupancyLost(room: string, why: string): void {
    if (this.stopped) return;
    if (!this.joined.has(room) || this.pendingJoins.has(room)) return;
    this.forgetRoom(room);

    const now = Date.now();
    const prior = this.rejoins.get(room);
    clearTimeout(prior?.timer);
    const losses = prior !== undefined && now - prior.at < REJOIN_WINDOW_MS ? prior.losses + 1 : 1;

    if (!this.subscriptions.has(room)) {
      this.rejoins.set(room, { losses, at: now });
      console.error(`[parley-xmpp] occupancy in ${room} ended (${why})`);
      return;
    }
    if (losses > REJOIN_LIMIT) {
      this.rejoins.set(room, { losses, at: now });
      console.error(
        `[parley-xmpp] occupancy in ${room} ended (${why}) ${losses} consecutive times, each ` +
          `within ${REJOIN_WINDOW_MS} ms of the previous — not re-entering it again; live push for ` +
          'this topic stays dead until a post or fetchRecent re-enters the room',
      );
      return;
    }
    const wait = REJOIN_BASE_MS * 2 ** (losses - 1) + Math.floor(Math.random() * REJOIN_BASE_MS);
    console.error(`[parley-xmpp] occupancy in ${room} ended (${why}); re-joining in ${wait} ms`);
    this.rejoins.set(room, {
      losses,
      at: now,
      timer: setTimeout(() => this.rejoinAfterLoss(room), wait),
    });
  }

  private rejoinAfterLoss(room: string): void {
    if (this.stopped || !this.subscriptions.has(room)) return;
    this.redriveJoin(room, 'losing occupancy');
  }

  /** Re-enter `room` in the background, reporting a failure rather than swallowing the rejection. */
  private redriveJoin(room: string, after: string): void {
    void this.ensureJoinedRoom(room).catch((err: unknown) => {
      console.error(
        `[parley-xmpp] re-join after ${after} failed for ${room}: ${wire.asError(err).message}`,
      );
    });
  }

  /**
   * Unlock a room we just created, asking for a PERSISTENT one: a non-persistent MUC and its archive
   * die with the last occupant, which every stream drop causes — so catch-up cannot survive a blip.
   */
  private async configureRoom(room: string): Promise<void> {
    const conn = this.require();
    try {
      await conn.iqCaller.request(wire.roomConfigIq(room, true), MAM_TIMEOUT_MS);
    } catch (err) {
      console.error(
        `[parley-xmpp] ${room} refused the persistent-room config (${wire.conditionOf(err)}), so it was ` +
          'created NON-PERSISTENT: this room and its MAM archive are destroyed when the last ' +
          'occupant leaves — which every stream drop causes — and catch-up then returns an empty ' +
          'history. Configure the MUC service to default rooms persistent, or pre-create the room.',
      );
      await conn.iqCaller.request(wire.roomConfigIq(room, false), MAM_TIMEOUT_MS).catch((e: unknown) => {
        console.error(
          `[parley-xmpp] ${room} also refused the bare instant-room config (${wire.conditionOf(e)}), ` +
            'so it stays LOCKED: nobody else can enter it and this bridge is its only occupant, ' +
            'so the room and its archive die with this connection.',
        );
      });
    }
  }

  private onMamResult(result: wire.El, fromBare: string): void {
    const collector = this.mamCollectors.get(result.attrs.queryid ?? '');
    if (collector === undefined) return;
    // Keep the XEP-0313 room check, so that a `<result>` routed from anywhere else cannot be
    // collected as this room's history.
    if (fromBare !== collector.room) return;
    const item = wire.archivedItem(result);
    if (item !== undefined) collector.items.push(item);
  }

  private onGroupchat(stanza: wire.El): void {
    const from = stanza.attrs.from ?? '';
    const room = jid.bareOf(from);
    const archId = wire.roomStanzaId(stanza, room);

    // The origin-id is public to every occupant, so keep the occupant-JID check, so that a
    // co-occupant echoing it cannot resolve our post with THEIR archive position — which core
    // would then store as our backendMsgId and cursor.
    const originId = stanza.getChild('origin-id', wire.NS_SID)?.attrs.id;
    if (originId !== undefined) {
      const pending = this.pendingPosts.get(originId);
      const ours = jid.resourceOf(from) === this.occupantNick(room) && room === pending?.room;
      if (pending !== undefined && ours) {
        this.pendingPosts.delete(originId);
        if (archId !== undefined) {
          pending.resolve(asBackendMsgId(archId));
        } else {
          pending.reject(
            new Error(`${room} reflected this post without a <stanza-id> — ${MAM_MISSING_HINT}`),
          );
        }
      }
    }

    if (archId === undefined) return;
    this.fireWaiters(room);
    const sub = this.subscriptions.get(room);
    if (sub === undefined) return;
    const body = stanza.getChildText('body');
    if (body === null) return;
    const msg = this.toMessage(sub.topic, { archId, from, body, stamp: wire.roomStamp(stanza, room) });
    for (const h of sub.handlers) {
      try {
        h(msg);
      } catch {
        /* handler is best-effort; never break the live path (DESIGN §6) */
      }
    }
  }

  /** Run one MAM page; the streamed `<result>` items are gathered by `queryid`. */
  private async mamQuery(
    topic: Topic,
    opts: { after?: string; lastPage?: boolean; max: number },
  ): Promise<{ items: wire.MamItem[]; complete: boolean }> {
    const room = this.roomJid(topic);
    const queryid = randomUUID();
    const collector: wire.MamItem[] = [];
    this.mamCollectors.set(queryid, { room, items: collector });
    try {
      const fin = await this.require().iqCaller.request(
        wire.mamQueryIq(room, queryid, opts),
        MAM_TIMEOUT_MS,
      );
      const complete = fin.getChild('fin', wire.NS_MAM)?.attrs.complete === 'true';
      return { items: collector.slice(), complete };
    } catch (err) {
      const condition = wire.conditionOf(err);
      if (condition === 'service-unavailable' || condition === 'feature-not-implemented') {
        throw new Error(`MAM query on ${room} answered ${condition} — ${MAM_MISSING_HINT}`);
      }
      throw err;
    } finally {
      this.mamCollectors.delete(queryid);
    }
  }

  private toMessage(topic: Topic, it: wire.BodiedItem): Message {
    return buildMessage({
      topic,
      sender: jid.senderOf(it.from, this.handle),
      content: it.body,
      timestamp: it.stamp ?? new Date().toISOString(),
      id: it.archId,
    });
  }

  /**
   * A reconnect restores the stream but not MUC occupancy — that is presence, and the library does
   * not re-send it. Re-drive every room in `joined`, not just the subscribed ones, so that a
   * catch-up-only topic is not left silently outside its room until some later post re-enters it.
   */
  private rejoinAfterReconnect(): void {
    for (const pp of this.pendingPosts.values()) pp.reject(new Error('reconnected; retry post'));
    this.pendingPosts.clear();
    for (const room of this.forgetAllRooms()) this.redriveJoin(room, 'reconnect');
  }

  /**
   * Take the bridge's logical handle as the occupant nick, unless `backend_config.nick` pinned one.
   * The occupant nick is the sender of every archived message and therefore the key core's
   * `parley_list_users` roster is built on; a random per-connection nick would make every restart of
   * one bridge a new phantom identity that no one can hand work off to. Rooms already entered under
   * the provisional nick are re-entered under the new one (XEP-0045 §7.6 nick change).
   *
   * One connection is one occupant, so a LATER `post` under a different handle is archived under the
   * adopted nick — the collapse this backend declares by answering `carriesSenderIdentity: false`.
   * It is reported once, because a sender the archive disagrees with is otherwise indistinguishable
   * from the seam working.
   */
  private adoptIdentityNick(identity: Handle): Promise<void> {
    const wanted = jid.nickFor(identity);
    if (this.nickAdoption === undefined) {
      this.adoptedNick = wanted;
      this.nickAdoption = this.switchNick(wanted);
    } else if (this.adoptedNick !== undefined && wanted !== this.adoptedNick) {
      this.reportIdentityCollapse(wanted);
    }
    return this.nickAdoption;
  }

  private reportIdentityCollapse(wanted: string): void {
    if (this.identityCollapseReported) return;
    this.identityCollapseReported = true;
    console.error(
      `[parley-xmpp] this connection posts as '${this.adoptedNick ?? this.nick}' (taken from the ` +
        `first post's identity.handle), so a post under '${wanted}' is archived — and read back — ` +
        `as '${this.adoptedNick ?? this.nick}'. One MUC occupant is one sender: run one bridge per ` +
        'handle, or pin backend_config.nick, if the two must stay distinct.',
    );
  }

  /**
   * Take `wanted` as the occupant nick and re-enter every room already joined under the old one.
   * Keep the `conflict` fallback in {@link doJoin} rather than here, so that a nick another occupant
   * holds produces one outcome and one diagnostic whether the first seam call was a `post` or a
   * `subscribe`.
   */
  private async switchNick(wanted: string): Promise<void> {
    if (wanted === '' || wanted === this.nick) return;
    this.nick = wanted;
    const rooms = this.forgetAllRooms();
    if (rooms.length === 0) return;
    await Promise.allSettled(rooms.map((r) => this.ensureJoinedRoom(r)));
  }

  /**
   * Fall back to the nick this connection started with when another occupant holds the one it asked
   * for, while `joiningRoom` is the room whose join was answered `conflict`. A pinned
   * `backend_config.nick`, or a conflict on the provisional nick itself, has no fallback left and
   * leaves the nick alone so the condition surfaces.
   *
   * Keep every OTHER room this connection occupies on the nick it entered under: dropping the
   * connection-wide nick out from under it would make its own reflections fail the provenance check
   * in {@link onGroupchat}, and every post there would stall to POST_TIMEOUT_MS with nothing left
   * to re-reconcile it.
   */
  private revertToProvisionalNick(joiningRoom: string): void {
    const provisional = this.provisionalNick;
    if (provisional === undefined || provisional === this.nick) return;
    console.error(
      `[parley-xmpp] could not take '${this.nick}' as this connection's MUC nick (another occupant ` +
        `holds it); posting as '${provisional}' instead, so parley_list_users will report that ` +
        'name. Pin backend_config.nick to a free name to fix this permanently.',
    );
    for (const room of this.joined.keys()) {
      if (room !== joiningRoom) this.roomNicks.set(room, this.occupantNick(room));
    }
    this.nick = provisional;
  }

  private occupantNick(room: string): string {
    return this.roomNicks.get(room) ?? this.nick;
  }

  private forgetRoom(room: string): void {
    this.joined.delete(room);
    this.roomNicks.delete(room);
  }

  /** Drop every join, returning the rooms that have to be re-entered. */
  private forgetAllRooms(): string[] {
    const rooms = [...this.joined.keys()];
    this.joined.clear();
    this.roomNicks.clear();
    return rooms;
  }

  /**
   * MAM is this backend's one hard prerequisite: the archive id IS the cursor and the post
   * correlator. Probe the room's disco#info so a server without it fails with a message that names
   * MAM, rather than as a post that times out and a subscribe that is silently dead. A server that
   * will not answer disco at all is not evidence of anything, so keep that path permissive.
   *
   * Keep the FAILURE uncached, so that enabling muc_mam server-side is not a change the bridge can
   * see only across a restart, and so that the next room's failure names the room it is about rather
   * than replaying the first probe's.
   */
  private assertMamAvailable(room: string): Promise<void> {
    this.mamCheck ??= this.discoMam(room).catch((err: unknown) => {
      this.mamCheck = undefined;
      throw err;
    });
    return this.mamCheck;
  }

  private async discoMam(room: string): Promise<void> {
    let info: wire.El;
    try {
      info = await this.require().iqCaller.request(wire.discoInfoIq(room), DISCO_TIMEOUT_MS);
    } catch {
      return;
    }
    if (wire.advertisesFeature(info, wire.NS_MAM)) return;
    throw new Error(`${room} does not advertise ${wire.NS_MAM} — ${MAM_MISSING_HINT}`);
  }

  /**
   * Whether the topic's MUC room already exists. Joining a room auto-CREATES it and then makes it
   * persistent, so keep the READ path behind this check: a wildcard allowlist pattern would otherwise
   * let a caller-supplied topic mint unbounded persistent rooms and archives that nothing reclaims.
   * An answer other than `item-not-found` is no evidence of absence, so keep that path permissive.
   */
  private async roomExists(topic: Topic): Promise<boolean> {
    const room = this.roomJid(topic);
    if (this.joined.has(room)) return true;
    try {
      await this.require().iqCaller.request(wire.discoInfoIq(room), DISCO_TIMEOUT_MS);
      return true;
    } catch (err) {
      return wire.conditionOf(err) !== 'item-not-found';
    }
  }

  private ensureJoinedRoom(room: string): Promise<void> {
    const cached = this.joined.get(room);
    if (cached !== undefined) return cached;
    const p = this.doJoin(room).then(() => this.assertMamAvailable(room));
    this.joined.set(room, p);
    // If the join fails, drop the cache so a later call can retry.
    p.catch(() => {
      if (this.joined.get(room) === p) this.forgetRoom(room);
    });
    return p;
  }

  /**
   * Join with bounded retry for the transient cold-creation race: N instances joining a brand-new
   * room at once see `item-not-found` until the one that creates it commits. Surface anything else.
   *
   * A `conflict` is the one other recoverable answer: the nick this connection asked for is held by
   * another occupant, so it reverts to its provisional nick and re-joins once. Keep the retry when
   * a CONCURRENT join already reverted the nick, so that the room that raced the revert does not
   * stay outside its room until the next seam call.
   */
  private async doJoin(room: string): Promise<void> {
    let nickRetried = false;
    for (let attempt = 0; ; attempt++) {
      const usedNick = this.nick;
      try {
        await this.joinOnce(room);
        return;
      } catch (err) {
        const cond = err instanceof wire.JoinError ? err.condition : undefined;
        if (cond !== undefined && RETRYABLE_CONDITIONS.includes(cond) && attempt < JOIN_RETRIES) {
          await delay(100 + 100 * attempt);
          continue;
        }
        if (cond === 'conflict' && !nickRetried) {
          this.revertToProvisionalNick(room);
          if (this.nick !== usedNick) {
            nickRetried = true;
            continue;
          }
        }
        throw err;
      }
    }
  }

  private joinOnce(room: string): Promise<void> {
    // Resolve the connection BEFORE registering, so that a join attempted after disconnect cannot
    // leave a correlator and a 15 s timer behind that nothing will ever settle.
    const conn = this.require();
    let superseded: PendingJoin | undefined;
    const attempt = new Promise<void>((resolve, reject) => {
      // Keep the slot cleared only when it still holds THIS entry: a re-join registers a successor
      // under the same key, and an unguarded delete from the loser's timer would drop the
      // successor's registration — its self-presence ignored, the room silently unjoined.
      const settle = (finish: () => void): void => {
        clearTimeout(timer);
        if (this.pendingJoins.get(room) === entry) this.pendingJoins.delete(room);
        finish();
      };
      const entry: PendingJoin = {
        nick: this.nick,
        resolve: () => settle(resolve),
        reject: (err) => settle(() => reject(err)),
        settleFrom: (outcome) => {
          clearTimeout(timer);
          outcome.then(
            () => settle(resolve),
            (err: unknown) => settle(() => reject(wire.asError(err))),
          );
        },
      };
      const timer = setTimeout(
        () => entry.reject(new Error(`MUC join timeout for ${room}`)),
        JOIN_TIMEOUT_MS,
      );
      superseded = this.pendingJoins.get(room);
      this.pendingJoins.set(room, entry);

      const presence = wire.joinPresence(room, this.nick);
      // A send that throws SYNCHRONOUSLY never reaches `.catch`; keep the try, so that it cannot
      // reject the join while leaving this entry and its 15 s timer registered behind it.
      try {
        conn.send(presence).catch((err: unknown) => entry.reject(wire.asError(err)));
      } catch (err) {
        entry.reject(wire.asError(err));
      }
    });
    // A re-drive (reconnect, nick switch, deferred re-entry after an occupancy loss) registers a
    // successor for a room whose join is still in flight. Settle the loser FROM the successor rather
    // than rejecting it, or an innocent subscribe/post/fetch is aborted — which startPushLoop
    // rethrows, taking the whole bridge process down during startup.
    superseded?.settleFrom(attempt);
    return attempt;
  }

  private roomJid(topic: Topic): string {
    return `${jid.roomLocalpart(topic)}@${this.mucService}`;
  }

  private require(): wire.XmppClient {
    if (this.stopped || this.xmpp === undefined) {
      throw new Error('XmppPlugin not connected — call connect() first');
    }
    return this.xmpp;
  }
}
