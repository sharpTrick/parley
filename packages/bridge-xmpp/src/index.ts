import {
  asBackendMsgId,
  asCursor,
  asTopic,
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
  safeName,
  type Topic,
} from '@sharptrick/parley-core';
import { delay } from '@sharptrick/parley-net-util';
import { client, xml } from '@xmpp/client';
import { randomBytes, randomUUID } from 'node:crypto';

/** Plugin-specific backend_config. */
export interface XmppBackendConfig {
  /** Connection URI. Default `xmpp://127.0.0.1:5222`. */
  service?: string;
  /** XMPP domain (the user's host). Default `parley.local`. */
  domain?: string;
  /** MUC service host — rooms live at `<topic>@<muc_service>`. Default `muc.parley.local`. */
  muc_service?: string;
  /** SASL username. Default `parley`. */
  username?: string;
  /** SASL password. Default `parleypass`. */
  password?: string;
  /**
   * MUC nickname for this connection — the sender every archived message reports. Setting it
   * pins the occupant identity; leaving it unset lets the bridge take its own `identity.handle`
   * (the first `post`'s argument) as the nick, which is what makes the sender stable across
   * restarts and keyed the same way core's roster is.
   */
  nick?: string;
  /** RSM page size for MAM catch-up paging. Default 200. */
  mam_page?: number;
}

// XML namespaces (XEP-0045 MUC, XEP-0313 MAM, XEP-0359 SID, XEP-0297 forward, XEP-0203 delay, RSM).
const NS_MUC = 'http://jabber.org/protocol/muc';
const NS_MUC_USER = 'http://jabber.org/protocol/muc#user';
const NS_MAM = 'urn:xmpp:mam:2';
const NS_SID = 'urn:xmpp:sid:0';
const NS_FORWARD = 'urn:xmpp:forward:0';
const NS_DELAY = 'urn:xmpp:delay';
const NS_RSM = 'http://jabber.org/protocol/rsm';
const NS_MUC_OWNER = 'http://jabber.org/protocol/muc#owner';
const NS_ROOMCONFIG = 'http://jabber.org/protocol/muc#roomconfig';
const NS_XDATA = 'jabber:x:data';
const NS_STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas';
const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info';

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
/** Consecutive remote losses, each within {@link REJOIN_WINDOW_MS} of the last, after which the
 * room is left alone. */
const REJOIN_LIMIT = 6;
/** Occupancy held this long counts as recovered: the consecutive-loss count starts over. */
const REJOIN_WINDOW_MS = 60_000;
/** Longest wait the {@link REJOIN_LIMIT}-step ladder can produce, jitter excluded. */
export const REJOIN_MAX_WAIT_MS = REJOIN_BASE_MS * 2 ** (REJOIN_LIMIT - 1);
/** Bounded retry for the transient MUC cold-creation race (see {@link XmppPlugin.doJoin}). */
const JOIN_RETRIES = 8;
/** Conditions that mean "room not committed yet" — retryable during concurrent cold-start. */
const RETRYABLE_CONDITIONS = ['item-not-found', 'recipient-unavailable', 'remote-server-not-found'];
/**
 * Bounce conditions that mean this connection is no longer an occupant of the room it addressed.
 * Occupancy can end without the stream dropping, and the join cache would otherwise hold a
 * resolved promise for a room we are not in.
 */
const NOT_AN_OCCUPANT_CONDITIONS = [
  'not-acceptable',
  'gone',
  'item-not-found',
  'recipient-unavailable',
];
/** XEP-0045 §7.6: our own occupant going unavailable to take a NEW nick, not to leave. */
const STATUS_NICK_CHANGE = '303';
/** XEP-0045 status codes that explain why our occupancy ended (kick, ban, affiliation, shutdown). */
const OCCUPANCY_END_STATUS: Record<string, string> = {
  '301': 'banned',
  '307': 'kicked',
  '321': 'affiliation change',
  '322': 'room became members-only',
  '332': 'MUC service shutting down',
  '333': 'occupant technical error',
};

// Correlators (origin-id, nick) are published in the room on every post, so a co-occupant sees
// them: keep this crypto-random, or an observer can predict the next one and race the reflection.
const rand = (): string => randomBytes(8).toString('hex');
const resourceOf = (full: string): string => {
  const i = full.indexOf('/');
  return i === -1 ? '' : full.slice(i + 1);
};
const bareOf = (full: string): string => {
  const i = full.indexOf('/');
  return i === -1 ? full : full.slice(0, i);
};
/**
 * Who a stanza's `from` says said it: the occupant nick, or — for a room-level stanza, which has no
 * resource — the room itself. Keep the room out of `fallback`, so that a service announcement is
 * never attributed to this bridge's own handle and read back as something it said.
 */
const senderOf = (from: string, fallback: string): string => {
  const nick = resourceOf(from);
  if (nick !== '') return nick;
  const bare = bareOf(from);
  return bare !== '' ? bare : fallback;
};

/** The first codepoint of `s` outside XML 1.0's `Char` production, or `undefined` if all are legal. */
const xmlIllegalCodepoint = (s: string): number | undefined => {
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x9 || cp === 0xa || cp === 0xd) continue;
    if (cp < 0x20 || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff) return cp;
  }
  return undefined;
};
const asU = (cp: number): string => `U+${cp.toString(16).toUpperCase().padStart(4, '0')}`;
/**
 * A stanza carrying a codepoint XML forbids is not rejected per-stanza: the server aborts the
 * whole stream with `not-well-formed`, which ends MUC occupancy for EVERY room this connection
 * serves. Keep every string that reaches the wire behind this check, so that one topic's payload
 * cannot take down the others.
 */
const assertXmlSafe = (value: string, what: string): void => {
  const cp = xmlIllegalCodepoint(value);
  if (cp !== undefined) {
    throw new Error(
      `${what} contains ${asU(cp)}, which XML forbids — refusing to send it (the server would ` +
        'abort the stream and every MUC room this connection occupies with it)',
    );
  }
};

/** Every key `backend_config` may carry. Also the set README and DESIGN §11 are checked against. */
export const CONFIG_KEYS = [
  'service',
  'domain',
  'muc_service',
  'username',
  'password',
  'nick',
  'mam_page',
] as const;
/** Keys that end up as one part of a JID, where a separator would silently build a different JID. */
const JID_PART_KEYS = ['domain', 'muc_service', 'username'] as const;
/** RFC 7622 §3.3/§3.4: a localpart or resourcepart longer than this is `jid-malformed`. */
const JID_PART_MAX_BYTES = 1023;
const MAX_MAM_PAGE = 10_000;

/** Schemes whose stream starts in the clear; STARTTLS on them is opportunistic, never guaranteed. */
const PLAINTEXT_SCHEMES = ['xmpp:', 'ws:'];
/**
 * The whole 127.0.0.0/8 block as an ADDRESS. Keep it anchored at both ends, so that a registrable
 * hostname beginning `127.` — which resolves wherever its owner points it — cannot be classified
 * loopback and silence the only warning on the cleartext-credential path.
 */
const LOOPBACK_V4 = /^127(\.\d{1,3}){3}$/;

/**
 * Whether `service` would put the SASL password on the network in the clear. `@xmpp/starttls`
 * upgrades only when the peer ADVERTISES the feature and `@xmpp/client` registers SASL PLAIN
 * unconditionally, so an on-path attacker that strips `<starttls/>` from the stream features is
 * handed the credential — there is nothing in the library that refuses to go on without it.
 */
export function isPlaintextRemote(service: string): boolean {
  const scheme = /^([a-z][a-z0-9+.-]*:)/i.exec(service.trim())?.[1]?.toLowerCase();
  if (scheme === undefined || !PLAINTEXT_SCHEMES.includes(scheme)) return false;
  const authority = service.trim().slice(scheme.length).replace(/^\/\//, '');
  const host = (/^([^/?#]*)/.exec(authority)?.[1] ?? '')
    .replace(/^[^@]*@/, '')
    .replace(/^(\[[^\]]*]):\d+$/, '$1')
    .replace(/^\[(.*)]$/, '$1')
    .replace(/^([^:]*):\d+$/, '$1')
    .toLowerCase();
  return !(host === 'localhost' || host === '::1' || LOOPBACK_V4.test(host) || host === '');
}

const describeValue = (v: unknown): string => (typeof v === 'string' ? `'${v}'` : String(v));
const bad = (key: string, reason: string): Error =>
  new Error(`parley-xmpp: invalid backend_config.${key} — ${reason}`);

/**
 * Validate `backend_config` before the client is constructed (§11). Keep an unknown key a load
 * error, so that a misspelled one cannot leave every room addressed at the default MUC service and
 * every join bouncing a retryable condition that names neither the key nor this plugin.
 */
export function validateBackendConfig(config: BackendConfig): XmppBackendConfig {
  const cfg = config as Record<string, unknown>;
  for (const key of Object.keys(cfg)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `parley-xmpp: unknown backend_config key '${key}' — expected one of ${CONFIG_KEYS.join(', ')}`,
      );
    }
  }
  for (const key of CONFIG_KEYS) {
    if (key === 'mam_page') continue;
    const value = cfg[key];
    if (value !== undefined && (typeof value !== 'string' || value === '')) {
      throw bad(key, `expected a non-empty string, got ${describeValue(value)}`);
    }
    if (typeof value === 'string') assertXmlSafe(value, `backend_config.${key}`);
  }
  for (const key of JID_PART_KEYS) {
    const value = cfg[key];
    if (typeof value === 'string' && /[\s@/]/.test(value)) {
      throw bad(
        key,
        `${describeValue(value)} contains whitespace, '@' or '/' — it is one part of a JID, and a ` +
          'separator here builds a different address than the one written',
      );
    }
  }
  const nick = cfg['nick'];
  if (typeof nick === 'string' && nick.includes('/')) {
    throw bad(
      'nick',
      `${describeValue(nick)} contains '/' — the nick is the JID resource, so this connection could ` +
        'not recognise its own presence back from the room',
    );
  }
  const page = cfg['mam_page'];
  if (
    page !== undefined &&
    (typeof page !== 'number' || !Number.isInteger(page) || page < 1 || page > MAX_MAM_PAGE)
  ) {
    throw bad(
      'mam_page',
      `expected an integer between 1 and ${MAX_MAM_PAGE}, got ${describeValue(page)}`,
    );
  }
  return cfg as XmppBackendConfig;
}

/** A minimal view of the ltx element / @xmpp client surface we use (no upstream types ship). */
type El = {
  name: string;
  is(name: string, ns?: string): boolean;
  attrs: Record<string, string>;
  children: Array<El | string>;
  getChild(name: string, ns?: string): El | undefined;
  getChildren(name: string, ns?: string): El[];
  getChildText(name: string, ns?: string): string | null;
};
type XmppClient = {
  jid?: { toString(): string };
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  send(el: unknown): Promise<unknown>;
  on(event: string, cb: (arg?: unknown) => void): void;
  iqCaller: { request(el: unknown, timeout?: number): Promise<El> };
};

/**
 * The RFC 6120 §8.3 defined-condition child of a stanza's `<error>`, plus its optional `<text>`.
 */
const stanzaError = (stanza: El): { condition: string; text: string } => {
  const err = stanza.getChild('error');
  if (err === undefined) return { condition: 'error', text: '' };
  const defined = err.children.find(
    (c): c is El => typeof c !== 'string' && c.name !== 'text',
  );
  return {
    condition: defined?.name ?? err.attrs.type ?? 'error',
    text: err.getChildText('text', NS_STANZAS) ?? err.getChildText('text') ?? '',
  };
};
const describeError = (e: { condition: string; text: string }): string =>
  e.text !== '' ? `${e.condition}: ${e.text}` : e.condition;

const occupancyEndReason = (statuses: string[], x: El | undefined): string => {
  const named = statuses.map((c) => OCCUPANCY_END_STATUS[c]).filter((s) => s !== undefined);
  if (x?.getChild('destroy') !== undefined) named.push('room destroyed');
  return named.length > 0 ? named.join(', ') : 'left the room';
};

const MAM_MISSING_HINT =
  'this backend needs XEP-0313 MAM for MUC — enable mod_mam + muc_mam (Prosody) or mod_mam ' +
  '(ejabberd); without an archive there is no cursor, no catch-up and no live delivery';
const conditionOf = (err: unknown): string =>
  typeof (err as { condition?: unknown })?.condition === 'string'
    ? ((err as { condition: string }).condition)
    : err instanceof Error
      ? err.message
      : String(err);

/** Carries the XMPP error condition so the join loop can decide whether to retry. */
class JoinError extends Error {
  constructor(
    readonly condition: string,
    room: string,
    text = '',
  ) {
    super(`MUC join error (${describeError({ condition, text })}) for ${room}`);
  }
}

interface PendingJoin {
  /** The nick this join's presence was addressed to; only a presence naming it (or one carrying
   * XEP-0045 status 210) can be attributed to it. */
  nick: string;
  resolve(): void;
  reject(err: Error): void;
  /** Hand this entry's outcome to a successor join for the same room (see {@link XmppPlugin.joinOnce}). */
  settleFrom(outcome: Promise<void>): void;
}
interface PendingPost {
  /** The room this post was sent to; only its own reflection may resolve the correlator. */
  room: string;
  resolve(id: BackendMsgId): void;
  reject(err: Error): void;
}
interface MamItem {
  archId: string;
  from: string;
  /** `null` for a stanza with no `<body>` at all — a subject change, a retraction, a chat state. */
  body: string | null;
  stamp?: string;
}
/** A {@link MamItem} the seam can carry: the live path admits exactly these, so catch-up must too. */
type BodiedItem = MamItem & { body: string };
const hasBody = (it: MamItem): it is BodiedItem => it.body !== null;
interface Subscription {
  topic: Topic;
  handlers: MessageHandler[];
}
/** Why a long-poll waiter woke: only `message` implies the archive may still be lagging. */
type WakeReason = 'message' | 'timeout' | 'cancel';

/**
 * XMPP MUC backend (DESIGN §6/§9). A topic maps to a MUC room; the per-message
 * XEP-0359 stanza-id (== XEP-0313 MAM archive id) is a stable, server-assigned,
 * per-room-monotonic value used as BOTH `backendMsgId` (dedup key) and `cursor`
 * (order key). `post` resolves on the MUC's own reflection (carrying that stanza-id);
 * `fetchRecent` is a MAM query with RSM `<after>` (exclusive `since`); `subscribe`
 * delivers every reflected groupchat message carrying a room stanza-id.
 *
 * Catch-up REQUIRES server-side MAM (mod_mam + muc_mam); without it the room has no
 * archive and `fetchRecent` returns nothing. Core never compares cursor values — the
 * server's RSM `<after>` defines "strictly after"; the archive defines order.
 */
export class XmppPlugin implements BackendPlugin {
  private xmpp?: XmppClient;
  private domain = 'parley.local';
  private mucService = 'muc.parley.local';
  private handle = 'parley';
  private nick = `parley-${rand()}`;
  /**
   * The per-connection nick this bridge started with, kept as the fallback for a nick another
   * occupant already holds — `undefined` when `backend_config.nick` pinned the nick, where a
   * `conflict` is a misconfiguration to surface rather than to work around.
   */
  private provisionalNick?: string;
  private mamPage = MAM_PAGE;
  private stopped = false;
  private lastStreamErrorAt = 0;
  /** Settled once the occupant nick is final: pinned by config, or taken from `post`'s identity. */
  private nickAdoption?: Promise<void>;
  /** The nick taken from the FIRST post's identity; `undefined` when config pinned one instead. */
  private adoptedNick?: string;
  private identityCollapseReported = false;
  /** Memoized disco#info probe for the one prerequisite this backend cannot work without. */
  private mamCheck?: Promise<void>;

  /** roomJid -> in-flight/settled join (cached like an "ensure"; idempotent). */
  private readonly joined = new Map<string, Promise<void>>();
  /**
   * roomJid -> the occupant nick this connection actually holds in that room, once it differs from
   * {@link nick}: a nick-locking service rewrote it (XEP-0045 status 210), or the connection nick
   * moved on while this room stayed entered. Keyed per room rather than held as one field, so that
   * one room's nick cannot make this connection's own reflections in every OTHER room fail the
   * provenance check in {@link onGroupchat} — every post there would then stall to its timeout.
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
  private readonly mamCollectors = new Map<string, { room: string; items: MamItem[] }>();
  /** roomJid -> live subscription(s). */
  private readonly subscriptions = new Map<string, Subscription>();
  /**
   * Long-poll wakeups: roomJid -> one-shot callbacks armed by a blocking `fetchRecent`. Any live
   * groupchat message on that room — or `disconnect()` — fires every waiter, so the blocked fetch
   * reconciles against MAM and returns. Independent of `subscriptions`: a blocking fetch listens
   * on the live MUC delivery the push path already runs, it does not subscribe or join twice.
   */
  private readonly waiters = new Map<string, Set<(reason: WakeReason) => void>>();

  async connect(config: BackendConfig): Promise<void> {
    const cfg = validateBackendConfig(config);
    this.domain = cfg.domain ?? 'parley.local';
    this.mucService = cfg.muc_service ?? 'muc.parley.local';
    const username = cfg.username ?? 'parley';
    this.handle = username;
    this.nick = cfg.nick ?? `${username}-${rand()}`;
    this.provisionalNick = cfg.nick === undefined ? this.nick : undefined;
    this.mamPage = cfg.mam_page ?? MAM_PAGE;
    this.stopped = false;
    this.nickAdoption = cfg.nick === undefined ? undefined : Promise.resolve();
    this.adoptedNick = undefined;
    this.identityCollapseReported = false;
    this.mamCheck = undefined;

    const password = cfg.password ?? 'parleypass';
    if (cfg.password === undefined || password === 'parleypass') {
      console.warn(
        '[parley-xmpp] SECURITY: connecting with the built-in default password ' +
          "('parleypass'). Set backend_config.password to a real secret; a network-reachable " +
          'XMPP account provisioned with this password is world-readable/injectable.',
      );
    }
    const service = cfg.service ?? 'xmpp://127.0.0.1:5222';
    if (isPlaintextRemote(service)) {
      console.warn(
        `[parley-xmpp] SECURITY: service ${service} is a plaintext scheme to a non-loopback host. ` +
          "@xmpp/client's STARTTLS is opportunistic and SASL PLAIN is always offered, so a peer " +
          'that does not advertise (or that is stripped of) STARTTLS receives ' +
          'backend_config.password in the clear. Use xmpps:// or wss://.',
      );
    }

    const xmpp = client({
      service,
      domain: this.domain,
      username,
      password,
    }) as unknown as XmppClient;
    // Report on stderr, NEVER stdout, so that cli.ts's JSON-RPC channel stays parseable.
    xmpp.on('error', (err) => this.reportStreamError(err));
    xmpp.on('stanza', (stanza) => this.onStanza(stanza as El));
    let firstOnline = true;
    xmpp.on('online', () => {
      if (firstOnline) {
        firstOnline = false;
        return;
      }
      this.rejoinAfterReconnect();
    });
    await xmpp.start();
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
   * `<message type='groupchat'>` into the topic's room, resolved by the MUC's own reflection
   * (which carries the archive id). The sender on the wire is this connection's MUC nick, which
   * unless pinned by config is taken from `identity` on the first post (see
   * {@link adoptIdentityNick}). `opts.inReplyTo` is IGNORED — XEP-0461 replies exist, but nothing
   * this seam returns carries the relation back, so it is documented as dropped rather than
   * half-implemented (README "Notes / caveats").
   */
  async post(
    topic: Topic,
    identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    assertXmlSafe(content, 'post content');
    await this.adoptIdentityNick(identity);
    await this.ensureJoined(topic);
    const room = this.roomJid(topic);
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

    const message = xml(
      'message',
      { to: room, type: 'groupchat', id: originId },
      xml('body', {}, content),
      xml('origin-id', { xmlns: NS_SID, id: originId }),
    );
    await this.require().send(message);
    return promise;
  }

  async fetchRecent(args: FetchRecentArgs): Promise<FetchRecentResult> {
    const since = args.since === undefined ? undefined : String(args.since);
    if (!(await this.roomExists(args.topic))) {
      return { messages: [], nextCursor: args.since ?? asCursor('') };
    }
    await this.ensureJoined(args.topic);
    const limit = args.limit ?? 100;

    let items: BodiedItem[];
    if (since === undefined) {
      // No cursor at all: default window = most recent `limit` (RSM "last page" via empty <before/>).
      items = (await this.mamQuery(args.topic, { before: true, max: limit })).items.filter(hasBody);
    } else {
      items = await this.exclusiveMam(args.topic, since, limit);
    }
    const blockMs = Math.floor(args.blockMs ?? 0);
    if (items.length === 0 && blockMs > 0) {
      // An empty last-page window and an empty window after the zero cursor are the same window,
      // so the since-less arm long-polls on `''` rather than silently ignoring `blockMs`.
      items = await this.blockingMam(args.topic, since ?? '', limit, blockMs);
    }

    const messages = items.map((it) => this.toMessage(args.topic, it));
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : (args.since ?? asCursor(''));
    return { messages, nextCursor };
  }

  /**
   * Forward, exclusive MAM catch-up strictly after `since`, paged up to `limit`. `since === ''`
   * (the empty archive's zero cursor) means "from the very beginning": the first page omits
   * `<after/>` (guarded in mamQuery), later pages advance on real archive ids.
   *
   * Keep the page's UNFILTERED tail as the next `<after/>` and the loop's stop condition, so that a
   * page made entirely of items the seam does not carry still advances past them — filtering before
   * that would read as "archive exhausted" and withhold everything behind them forever.
   */
  private async exclusiveMam(topic: Topic, since: string, limit: number): Promise<BodiedItem[]> {
    const items: BodiedItem[] = [];
    let cursor = since; // may be '' on the first iteration → no <after/> emitted
    while (items.length < limit) {
      const page = await this.mamQuery(topic, {
        after: cursor,
        max: Math.min(this.mamPage, limit - items.length),
      });
      items.push(...page.items.filter(hasBody));
      if (page.complete || page.items.length === 0) break;
      cursor = page.items[page.items.length - 1]!.archId;
    }
    return items;
  }

  /**
   * Native long-poll: MUC-live-wait + MAM-reconcile. Each round REGISTERS the room waiter before
   * running the exclusive MAM query, so that a message reflected during the query's round trip
   * fires an already-registered waiter instead of firing into the void; its park timer only starts
   * once the query is back, so the park is the interval asked for rather than what a slow server
   * left of it. An empty return is always safe — the page carries `nextCursor === since` and
   * core's wrapper polls the rest.
   *
   * Once a live message has been seen, the archive is known to be behind the stream, and the
   * re-poll interval DOUBLES from {@link MAM_LAG_POLL_MS} instead of expiring back to the whole
   * remaining budget: a lag longer than a fixed window would otherwise withhold a message that is
   * already in the archive until the caller's `blockMs` ran out. Doubling keeps the return within
   * a small multiple of the actual lag while the number of queries stays logarithmic in `blockMs`
   * rather than linear in it.
   */
  private async blockingMam(
    topic: Topic,
    since: string,
    limit: number,
    blockMs: number,
  ): Promise<BodiedItem[]> {
    const deadline = Date.now() + blockMs;
    const room = this.roomJid(topic);
    let lagPoll = 0;
    for (;;) {
      if (this.stopped || Date.now() >= deadline) return [];
      const waiter = this.armWaiter(room);
      try {
        const items = await this.exclusiveMam(topic, since, limit);
        if (items.length > 0) return items;
        if (this.stopped) return [];
        const budget = deadline - Date.now();
        const park = lagPoll > 0 ? Math.min(budget, lagPoll) : budget;
        if (park <= 0) return [];
        const reason = await waiter.park(park);
        if (reason === 'message') lagPoll = MAM_LAG_POLL_MS;
        else if (reason === 'timeout' && lagPoll > 0) lagPoll *= 2;
      } catch (err) {
        if (this.stopped) return [];
        throw err;
      } finally {
        waiter.cancel();
      }
    }
  }

  /**
   * Register a one-shot long-poll waiter on `room`. It resolves when a live groupchat message for
   * that room arrives (via {@link fireWaiters}), when the `park(ms)` timer elapses, or when
   * `disconnect()` fires it — `park` may be called after the waiter has already fired, and then
   * arms no timer. Idempotent `cancel()` (also the fire path) clears the timer and de-registers.
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
    await this.ensureJoined(topic);
    const room = this.roomJid(topic);
    const existing = this.subscriptions.get(room);
    if (existing !== undefined) {
      existing.handlers.push(handler);
    } else {
      this.subscriptions.set(room, { topic, handlers: [handler] });
    }
  }

  async resolveIdentity(handle: Handle): Promise<BackendIdentity> {
    return { handle, backendRef: handle };
  }

  // ---- internals -----------------------------------------------------------

  private reportStreamError(err: unknown): void {
    const now = Date.now();
    if (now - this.lastStreamErrorAt < STREAM_ERROR_LOG_MS) return;
    this.lastStreamErrorAt = now;
    console.error(
      `[parley-xmpp] stream error: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  private onStanza(stanza: El): void {
    if (this.stopped) return;
    if (stanza.is('presence')) {
      this.onPresence(stanza);
      return;
    }
    if (!stanza.is('message')) return;

    // MAM streamed result? (outer stanza is a normal message addressed to us)
    const result = stanza.getChild('result', NS_MAM);
    if (result !== undefined) {
      this.onMamResult(result, bareOf(stanza.attrs.from ?? ''));
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
   * A MUC bounce of one of our stanzas (not an occupant, no voice, kicked/banned, room gone).
   * The reflection can never arrive, so fail the correlated post/join NOW with the server's
   * condition instead of burning the full timeout and reporting a causeless stall.
   *
   * A bounce that carries an id identifies exactly one post: it settles that post or nothing at
   * all. Keep it from falling through to the room's join, so that a late bounce for an already
   * cleared post cannot reject an unrelated operation with another operation's condition.
   */
  private onErrorMessage(stanza: El): void {
    const room = bareOf(stanza.attrs.from ?? '');
    const err = stanzaError(stanza);
    const originId = stanza.getChild('origin-id', NS_SID)?.attrs.id ?? stanza.attrs.id ?? '';
    if (originId !== '') {
      const post = this.pendingPosts.get(originId);
      if (post === undefined || post.room !== room) return;
      this.pendingPosts.delete(originId);
      if (NOT_AN_OCCUPANT_CONDITIONS.includes(err.condition)) {
        this.onOccupancyLost(room, describeError(err));
      }
      post.reject(new Error(`post rejected by ${room} (${describeError(err)})`));
      return;
    }
    this.pendingJoins.get(room)?.reject(new JoinError(err.condition, room, err.text));
  }

  private onPresence(stanza: El): void {
    const from = stanza.attrs.from ?? '';
    const room = bareOf(from);
    const resource = resourceOf(from);
    const x = stanza.getChild('x', NS_MUC_USER);
    const statuses = (x?.getChildren('status') ?? []).map((s) => s.attrs.code ?? '');
    // Self-presence: our own nick echoed back, or status code 110.
    const isSelf = resource === this.occupantNick(room) || statuses.includes('110');

    if (stanza.attrs.type === 'unavailable') {
      if (isSelf && !statuses.includes(STATUS_NICK_CHANGE)) {
        this.onOccupancyLost(room, occupancyEndReason(statuses, x));
      }
      return;
    }

    const pending = this.pendingJoins.get(room);
    if (stanza.attrs.type === 'error') {
      const err = stanzaError(stanza);
      pending?.reject(new JoinError(err.condition, room, err.text));
      return;
    }
    if (!isSelf) return;
    // A self-presence names the occupant nick it is about, and status 110 alone does NOT make it
    // this join's: the answer to a superseded join carries 110 for the nick that join asked for.
    // Attribute it to the nick the pending join was addressed to, or to an explicit service rewrite
    // (XEP-0045 status 210), so that a join is never settled for a nick this connection does not
    // hold — after which its own reflections fail the provenance check and every post stalls to
    // POST_TIMEOUT_MS.
    const assignedByService = statuses.includes('210');
    const addressed = pending?.nick ?? this.occupantNick(room);
    if (resource !== '' && resource !== addressed && !assignedByService) return;
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
    // Status 201 = we just CREATED the room; it stays locked until its owner submits a config.
    if (statuses.includes('201')) {
      this.configureRoom(room).finally(() => pending.resolve());
    } else {
      pending.resolve();
    }
  }

  /**
   * Occupancy ended without the stream dropping — kicked, banned, room destroyed, MUC component
   * restarted, or a post bounced as "not an occupant". `joined` caches a RESOLVED promise, so
   * without this the plugin would never re-enter the room: push would be permanently dead in
   * silence and every post would bounce forever. A join still in flight settles on its own.
   *
   * The re-entry is remote-driven, so it is DEFERRED and backs off: a room that ends occupancy on
   * every join (a moderation bot, a members-only toggle, a MUC service shutting down) would
   * otherwise be re-joined as fast as the loop can send presence — hundreds of stanzas a second at
   * a service that is deliberately going away, and one stderr line each. Keep the re-join off the
   * loss path itself, so that a loss delivered from inside a send cannot spin without ever yielding
   * to a timer.
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
    const wait =
      REJOIN_BASE_MS * 2 ** (losses - 1) + Math.floor(Math.random() * REJOIN_BASE_MS);
    console.error(`[parley-xmpp] occupancy in ${room} ended (${why}); re-joining in ${wait} ms`);
    this.rejoins.set(room, {
      losses,
      at: now,
      timer: setTimeout(() => this.rejoinAfterLoss(room), wait),
    });
  }

  private rejoinAfterLoss(room: string): void {
    if (this.stopped || !this.subscriptions.has(room)) return;
    void this.ensureJoinedRoom(room).catch((err: unknown) => {
      console.error(
        `[parley-xmpp] re-join after losing occupancy failed for ${room}: ` +
          `${err instanceof Error ? err.message : String(err)}`,
      );
    });
  }

  /**
   * Unlock a room we just created (XEP-0045 §10.1.2 config submit), asking for a PERSISTENT room:
   * a non-persistent MUC and its entire MAM archive are destroyed the instant the last occupant
   * leaves, which every stream drop causes — so catch-up history would not survive a network blip.
   * A service that refuses the field rejects the whole form, and an unsubmitted form leaves the
   * room locked, so keep the bare-submit fallback.
   */
  private async configureRoom(room: string): Promise<void> {
    const conn = this.require();
    const submit = (fields: unknown[]): unknown =>
      xml(
        'iq',
        { type: 'set', to: room },
        xml(
          'query',
          { xmlns: NS_MUC_OWNER },
          xml('x', { xmlns: NS_XDATA, type: 'submit' }, ...(fields as never[])),
        ),
      );
    await conn.iqCaller
      .request(
        submit([
          xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_ROOMCONFIG)),
          xml('field', { var: 'muc#roomconfig_persistentroom' }, xml('value', {}, '1')),
        ]),
        MAM_TIMEOUT_MS,
      )
      .catch(async () => {
        await conn.iqCaller.request(submit([]), MAM_TIMEOUT_MS).catch(() => undefined);
      });
  }

  private onMamResult(result: El, fromBare: string): void {
    const collector = this.mamCollectors.get(result.attrs.queryid ?? '');
    if (collector === undefined) return;
    // XEP-0313 security: only accept archive results from the room we queried.
    if (fromBare !== collector.room) return;
    const forwarded = result.getChild('forwarded', NS_FORWARD);
    const inner = forwarded?.getChild('message');
    if (inner === undefined) return;
    const delay = forwarded?.getChild('delay', NS_DELAY);
    collector.items.push({
      archId: result.attrs.id ?? '',
      from: inner.attrs.from ?? '',
      body: inner.getChild('body') === undefined ? null : (inner.getChildText('body') ?? ''),
      stamp: delay?.attrs.stamp,
    });
  }

  private onGroupchat(stanza: El): void {
    const from = stanza.attrs.from ?? '';
    const room = bareOf(from);
    // The MUC adds <stanza-id by='room' id='ARCHIVE_ID'>; pick the one stamped by this room.
    const archId = stanza
      .getChildren('stanza-id', NS_SID)
      .find((e) => e.attrs.by === room)?.attrs.id;

    // The origin-id is public to every occupant, so keep the occupant-JID check, so that a
    // co-occupant echoing it cannot resolve our post with THEIR archive position — which core
    // would then store as our backendMsgId and cursor.
    const originId = stanza.getChild('origin-id', NS_SID)?.attrs.id;
    if (originId !== undefined) {
      const pending = this.pendingPosts.get(originId);
      const ours = resourceOf(from) === this.occupantNick(room) && room === pending?.room;
      if (pending !== undefined && ours) {
        this.pendingPosts.delete(originId);
        if (archId !== undefined) {
          pending.resolve(asBackendMsgId(archId));
        } else {
          pending.reject(
            new Error(
              `${room} reflected this post without a <stanza-id> — ${MAM_MISSING_HINT}`,
            ),
          );
        }
      }
    }

    // Live delivery: every reflected message carrying a room stanza-id (incl. our own).
    if (archId === undefined) return;
    this.fireWaiters(room);
    const sub = this.subscriptions.get(room);
    if (sub === undefined) return;
    const body = stanza.getChildText('body');
    if (body === null) return;
    const msg = this.toMessage(sub.topic, {
      archId,
      from,
      body,
      stamp: stanza.getChild('delay', NS_DELAY)?.attrs.stamp,
    });
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
    opts: { after?: string; before?: boolean; max: number },
  ): Promise<{ items: MamItem[]; complete: boolean }> {
    const room = this.roomJid(topic);
    const rsm: unknown[] = [];
    // Keep the zero cursor '' omitting <after/> entirely, so that "from the beginning" never
    // depends on how a server answers an <after> UID it does not hold — RSM (XEP-0059) says
    // item-not-found, Prosody's mod_mam replays the whole archive.
    if (opts.after !== undefined && opts.after !== '') {
      assertXmlSafe(opts.after, 'catch-up cursor');
      rsm.push(xml('after', {}, opts.after));
    }
    rsm.push(xml('max', {}, String(opts.max)));
    if (opts.before === true) rsm.push(xml('before', {})); // empty <before/> => last page

    const queryid = randomUUID();
    const collector: MamItem[] = [];
    this.mamCollectors.set(queryid, { room, items: collector });
    const iq = xml(
      'iq',
      { type: 'set', to: room },
      xml(
        'query',
        { xmlns: NS_MAM, queryid },
        xml('set', { xmlns: NS_RSM }, ...(rsm as never[])),
      ),
    );
    try {
      const fin = await this.require().iqCaller.request(iq, MAM_TIMEOUT_MS);
      const complete = fin.getChild('fin', NS_MAM)?.attrs.complete === 'true';
      return { items: collector.slice(), complete };
    } catch (err) {
      const condition = conditionOf(err);
      if (condition === 'service-unavailable' || condition === 'feature-not-implemented') {
        throw new Error(`MAM query on ${room} answered ${condition} — ${MAM_MISSING_HINT}`);
      }
      throw err;
    } finally {
      this.mamCollectors.delete(queryid);
    }
  }

  private toMessage(topic: Topic, it: BodiedItem): Message {
    return buildMessage({
      topic,
      sender: senderOf(it.from, this.handle),
      content: it.body,
      timestamp: it.stamp ?? new Date().toISOString(),
      id: it.archId,
    });
  }

  /**
   * A reconnect restores the stream but not MUC occupancy — that is presence, and the library
   * does not re-send it. Re-drive every room in `joined`, not just the subscribed ones, so that a
   * catch-up-only topic is not left silently outside its room until some later post re-enters it.
   */
  private rejoinAfterReconnect(): void {
    for (const pp of this.pendingPosts.values()) pp.reject(new Error('reconnected; retry post'));
    this.pendingPosts.clear();
    for (const room of this.forgetAllRooms()) {
      void this.ensureJoinedRoom(room).catch((err: unknown) => {
        console.error(
          `[parley-xmpp] re-join after reconnect failed for ${room}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  /**
   * Take the bridge's logical handle as the occupant nick, unless `backend_config.nick` pinned
   * one. The occupant nick is the sender of every archived message and therefore the key core's
   * `parley_list_users` roster is built on; a random per-connection nick would make every restart
   * of one bridge a new phantom identity that no one can hand work off to. Rooms already entered
   * under the provisional nick are re-entered under the new one (XEP-0045 §7.6 nick change).
   *
   * One connection is one occupant, so a LATER `post` under a different handle is archived under the
   * adopted nick rather than its own — the collapse this backend declares by answering
   * `carriesSenderIdentity: false`. It is reported once, because a sender the archive disagrees with
   * is otherwise indistinguishable from the seam working.
   */
  private adoptIdentityNick(identity: Handle): Promise<void> {
    const wanted = nickFor(identity);
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
   * The `conflict` fallback lives in {@link doJoin}, not here: a nick taken by someone else has to
   * behave the same whether the first seam call was a `post` (nothing joined yet, so this returns
   * before any join is driven) or a `subscribe` — routing it through the join path is what makes
   * the two orderings produce one outcome and one diagnostic.
   */
  private async switchNick(wanted: string): Promise<void> {
    if (wanted === '' || wanted === this.nick) return;
    this.nick = wanted;
    const rooms = this.forgetAllRooms();
    if (rooms.length === 0) return;
    await Promise.allSettled(rooms.map((r) => this.ensureJoinedRoom(r)));
  }

  /**
   * Fall back to the nick this connection started with when another occupant holds the one it
   * asked for, while `joiningRoom` is the room whose join was answered `conflict`. A pinned
   * `backend_config.nick`, or a conflict on the provisional nick itself, has no fallback left and
   * leaves the nick alone so the condition surfaces.
   *
   * Every OTHER room this connection already occupies keeps the nick it entered under: it is still
   * that room's occupant, and dropping the connection-wide nick out from under it would make its own
   * reflections fail the provenance check in {@link onGroupchat} — every post there would stall to
   * POST_TIMEOUT_MS with nothing left to re-reconcile it.
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
   * correlator. Probe the room's disco#info once per connection so a server without it fails with
   * a message that names MAM, rather than as a post that times out and a subscribe that is
   * silently dead. A server that will not answer disco at all is not evidence of anything, so
   * keep that path permissive.
   */
  private assertMamAvailable(room: string): Promise<void> {
    this.mamCheck ??= this.discoMam(room);
    return this.mamCheck;
  }

  private async discoMam(room: string): Promise<void> {
    const iq = xml('iq', { type: 'get', to: room }, xml('query', { xmlns: NS_DISCO_INFO }));
    let info: El;
    try {
      info = await this.require().iqCaller.request(iq, DISCO_TIMEOUT_MS);
    } catch {
      return;
    }
    const features = info.getChild('query', NS_DISCO_INFO)?.getChildren('feature') ?? [];
    if (features.some((f) => f.attrs.var === NS_MAM)) return;
    throw new Error(`${room} does not advertise ${NS_MAM} — ${MAM_MISSING_HINT}`);
  }

  /** Join a room with NO history (maxstanzas=0); cached so repeated calls are idempotent. */
  private ensureJoined(topic: Topic): Promise<void> {
    return this.ensureJoinedRoom(this.roomJid(topic));
  }

  /**
   * Whether the topic's MUC room already exists. Joining a room auto-CREATES it and then makes it
   * persistent, so keep the READ path behind this check: `fetch_recent` takes a caller-supplied
   * topic through nothing but the allowlist pattern, and a wildcard pattern would otherwise let a
   * read mint an unbounded number of persistent rooms and archives that nothing ever reclaims.
   * A server that answers the probe with anything other than `item-not-found` is not evidence the
   * room is absent, so keep that path permissive.
   */
  private async roomExists(topic: Topic): Promise<boolean> {
    const room = this.roomJid(topic);
    if (this.joined.has(room)) return true;
    const iq = xml('iq', { type: 'get', to: room }, xml('query', { xmlns: NS_DISCO_INFO }));
    try {
      await this.require().iqCaller.request(iq, DISCO_TIMEOUT_MS);
      return true;
    } catch (err) {
      return conditionOf(err) !== 'item-not-found';
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
   * Join with bounded retry for the transient cold-creation race: when N instances join a
   * brand-new room at once, exactly one creates it and the rest briefly see `item-not-found`
   * until that creation commits. Retry those; surface anything else.
   *
   * A `conflict` is the one other recoverable answer: the nick this connection asked for is held by
   * another occupant, so it reverts to its provisional nick and re-joins once. The retry is also
   * taken when a CONCURRENT join already reverted the nick, so that only the room that raced the
   * revert pays for it rather than staying outside its room until the next seam call.
   */
  private async doJoin(room: string): Promise<void> {
    let nickRetried = false;
    for (let attempt = 0; ; attempt++) {
      const usedNick = this.nick;
      try {
        await this.joinOnce(room);
        return;
      } catch (err) {
        const cond = err instanceof JoinError ? err.condition : undefined;
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
      // Settle only ever clears the map slot when the slot is still THIS entry: a reconnect
      // re-join for a room whose previous join is still in flight registers a successor under the
      // same key, and an unguarded delete from the loser's timer would drop the successor's
      // registration — its self-presence would then be ignored and the room silently unjoined.
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
            (err: unknown) =>
              settle(() => reject(err instanceof Error ? err : new Error(String(err)))),
          );
        },
      };
      const timer = setTimeout(
        () => entry.reject(new Error(`MUC join timeout for ${room}`)),
        JOIN_TIMEOUT_MS,
      );
      superseded = this.pendingJoins.get(room);
      this.pendingJoins.set(room, entry);

      const presence = xml(
        'presence',
        { to: `${room}/${this.nick}` },
        xml('x', { xmlns: NS_MUC }, xml('history', { maxstanzas: '0' })),
      );
      conn.send(presence).catch((err: unknown) => {
        entry.reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
    // A re-drive (reconnect, nick switch, deferred re-entry after an occupancy loss) registers a
    // successor for a room whose join is still in flight. Settle the loser FROM the successor rather
    // than rejecting it: the caller that is awaiting it asked to be in the room, which is exactly
    // what the successor is doing, and the alternative aborts an innocent subscribe/post/fetch —
    // which startPushLoop rethrows, taking the whole bridge process down during startup.
    superseded?.settleFrom(attempt);
    return attempt;
  }

  private roomJid(topic: Topic): string {
    const local = safeName(topic, sanitizeLocal);
    if (local.length > JID_PART_MAX_BYTES) {
      throw new Error(
        `parley-xmpp: topic is ${String(topic).length} characters, whose MUC room localpart would ` +
          `be ${local.length} bytes — over the ${JID_PART_MAX_BYTES}-byte JID limit, which the ` +
          'server answers with jid-malformed. Use a shorter topic.',
      );
    }
    return `${local}@${this.mucService}`;
  }

  private require(): XmppClient {
    if (this.stopped || this.xmpp === undefined) {
      throw new Error('XmppPlugin not connected — call connect() first');
    }
    return this.xmpp;
  }
}

// JID localparts are case-insensitive and may not contain "&'/:<>@ or whitespace; fold to a
// safe, lowercase token. freshTopic() values (t-<n>-<rand>) pass through unchanged. Keep it free of
// a length limit, as {@link sanitizeNick} is: the ceiling is enforced on the fold's RESULT, because
// a fold that truncates makes safeName refuse the name it just built instead of returning it.
const sanitizeLocal = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.\-_]/g, '_');

// A MUC nick is a JID resource: no control characters, and nothing that would split the JID. The
// fold is injective via safeName, so two handles can never land on one occupant identity. Keep it
// free of a length limit, so that safeName's disambiguating suffix survives a re-fold — a truncating
// fold makes safeName refuse the handle outright, and with it every post made under that identity.
const sanitizeNick = (s: string): string => s.replace(/[^A-Za-z0-9.\-_]/g, '_');
const nickFor = (identity: Handle): string => {
  const raw = String(identity);
  if (raw === '') return '';
  const nick = safeName(asTopic(raw), sanitizeNick);
  if (nick.length > JID_PART_MAX_BYTES) {
    throw new Error(
      `parley-xmpp: identity.handle is ${raw.length} characters, whose MUC nick would be ` +
        `${nick.length} bytes — over the ${JID_PART_MAX_BYTES}-byte JID resource limit. Use a shorter ` +
        'identity.handle, or pin backend_config.nick.',
    );
  }
  return nick;
};
