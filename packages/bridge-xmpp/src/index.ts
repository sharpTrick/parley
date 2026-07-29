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
   * MUC nickname for this connection. MUST be unique per occupant in a room, so it
   * defaults to a random per-instance value (concurrent writers each get their own).
   */
  nick?: string;
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

const JOIN_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MS = 15_000;
const MAM_TIMEOUT_MS = 15_000;
/** Page size for forward MAM paging. */
const MAM_PAGE = 200;
/** Cadence of the bounded archival-lag re-poll that follows a live-message wake. */
const MAM_LAG_POLL_MS = 50;
/**
 * How many capped re-polls one live-message wake may buy. The product with
 * {@link MAM_LAG_POLL_MS} is the archival lag the long-poll can absorb; past it the fetch parks
 * again on the live stream, so the query count per blocked fetch is a function of how many
 * messages arrived, never of `blockMs`.
 */
const MAM_LAG_REPOLLS = 4;
/** Floor between two stream-error reports, so a reconnect storm can't flood stderr. */
const STREAM_ERROR_LOG_MS = 5_000;
/** Bounded retry for the transient MUC cold-creation race (see {@link XmppPlugin.doJoin}). */
const JOIN_RETRIES = 8;
/** Conditions that mean "room not committed yet" — retryable during concurrent cold-start. */
const RETRYABLE_CONDITIONS = ['item-not-found', 'recipient-unavailable', 'remote-server-not-found'];

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
  resolve(): void;
  reject(err: Error): void;
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
  body: string;
  stamp?: string;
}
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
  private stopped = false;
  private lastStreamErrorAt = 0;

  /** roomJid -> in-flight/settled join (cached like an "ensure"; idempotent). */
  private readonly joined = new Map<string, Promise<void>>();
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
    const cfg = config as XmppBackendConfig;
    this.domain = cfg.domain ?? 'parley.local';
    this.mucService = cfg.muc_service ?? 'muc.parley.local';
    const username = cfg.username ?? 'parley';
    this.handle = username;
    this.nick = cfg.nick ?? `${username}-${rand()}`;
    this.stopped = false;
    assertXmlSafe(this.nick, 'backend_config.nick');
    assertXmlSafe(this.mucService, 'backend_config.muc_service');

    const password = cfg.password ?? 'parleypass';
    if (cfg.password === undefined || password === 'parleypass') {
      console.warn(
        '[parley-xmpp] SECURITY: connecting with the built-in default password ' +
          "('parleypass'). Set backend_config.password to a real secret; a network-reachable " +
          'XMPP account provisioned with this password is world-readable/injectable.',
      );
    }

    const xmpp = client({
      service: cfg.service ?? 'xmpp://127.0.0.1:5222',
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
    this.joined.clear();
    if (this.xmpp !== undefined) {
      await this.xmpp.stop().catch(() => undefined);
      this.xmpp = undefined;
    }
  }

  /**
   * `<message type='groupchat'>` into the topic's room, resolved by the MUC's own reflection
   * (which carries the archive id). `identity` is informational only: the sender on the wire is
   * this connection's MUC nick (see README "Multiple concurrent sessions"). `opts.inReplyTo` is
   * IGNORED — XEP-0461 replies exist, but nothing this seam returns carries the relation back,
   * so it is documented as dropped rather than half-implemented (README "Notes / caveats").
   */
  async post(
    topic: Topic,
    _identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    assertXmlSafe(content, 'post content');
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
    await this.ensureJoined(args.topic);
    const limit = args.limit ?? 100;

    const since = args.since === undefined ? undefined : String(args.since);
    let items: MamItem[];
    if (since === undefined) {
      // No cursor at all: default window = most recent `limit` (RSM "last page" via empty <before/>).
      items = (await this.mamQuery(args.topic, { before: true, max: limit })).items;
    } else {
      items = await this.exclusiveMam(args.topic, since, limit);
      const blockMs = args.blockMs ?? 0;
      if (items.length === 0 && blockMs > 0) {
        items = await this.blockingMam(args.topic, since, limit, Math.floor(blockMs));
      }
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
   */
  private async exclusiveMam(topic: Topic, since: string, limit: number): Promise<MamItem[]> {
    const items: MamItem[] = [];
    let cursor = since; // may be '' on the first iteration → no <after/> emitted
    while (items.length < limit) {
      const page = await this.mamQuery(topic, {
        after: cursor,
        max: Math.min(MAM_PAGE, limit - items.length),
      });
      items.push(...page.items);
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
   */
  private async blockingMam(
    topic: Topic,
    since: string,
    limit: number,
    blockMs: number,
  ): Promise<MamItem[]> {
    const deadline = Date.now() + blockMs;
    const room = this.roomJid(topic);
    let lagRepolls = 0;
    for (;;) {
      if (this.stopped || Date.now() >= deadline) return [];
      const waiter = this.armWaiter(room);
      try {
        const items = await this.exclusiveMam(topic, since, limit);
        if (items.length > 0) return items;
        if (this.stopped) return [];
        const budget = deadline - Date.now();
        const park = lagRepolls > 0 ? Math.min(budget, MAM_LAG_POLL_MS) : budget;
        if (park <= 0) return [];
        const reason = await waiter.park(park);
        if (reason === 'message') lagRepolls = MAM_LAG_REPOLLS;
        else if (reason === 'timeout' && lagRepolls > 0) lagRepolls--;
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
      post.reject(new Error(`post rejected by ${room} (${describeError(err)})`));
      return;
    }
    this.pendingJoins.get(room)?.reject(new JoinError(err.condition, room, err.text));
  }

  private onPresence(stanza: El): void {
    const from = stanza.attrs.from ?? '';
    const room = bareOf(from);
    const pending = this.pendingJoins.get(room);
    if (pending === undefined) return;

    if (stanza.attrs.type === 'error') {
      const err = stanzaError(stanza);
      pending.reject(new JoinError(err.condition, room, err.text));
      return;
    }
    // Self-presence: our own nick echoed back, or status code 110.
    const x = stanza.getChild('x', NS_MUC_USER);
    const statuses = x?.getChildren('status') ?? [];
    const isSelf =
      resourceOf(from) === this.nick || statuses.some((s) => s.attrs.code === '110');
    if (!isSelf) return;
    // Status 201 = we just CREATED the room; it stays locked until its owner submits a config.
    if (statuses.some((s) => s.attrs.code === '201')) {
      this.configureRoom(room).finally(() => pending.resolve());
    } else {
      pending.resolve();
    }
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
      body: inner.getChildText('body') ?? '',
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
      const ours = resourceOf(from) === this.nick && room === pending?.room;
      if (pending !== undefined && ours && archId !== undefined) {
        this.pendingPosts.delete(originId);
        pending.resolve(asBackendMsgId(archId));
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
    const queryid = randomUUID();
    const collector: MamItem[] = [];
    this.mamCollectors.set(queryid, { room, items: collector });

    const rsm: unknown[] = [];
    // Keep the zero cursor '' omitting <after/> entirely, so that "from the beginning" never
    // depends on how a server answers an <after> UID it does not hold — RSM (XEP-0059) says
    // item-not-found, Prosody's mod_mam replays the whole archive.
    if (opts.after !== undefined && opts.after !== '') rsm.push(xml('after', {}, opts.after));
    rsm.push(xml('max', {}, String(opts.max)));
    if (opts.before === true) rsm.push(xml('before', {})); // empty <before/> => last page

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
    } finally {
      this.mamCollectors.delete(queryid);
    }
  }

  private toMessage(topic: Topic, it: MamItem): Message {
    const nick = resourceOf(it.from);
    return buildMessage({
      topic,
      sender: nick !== '' ? nick : this.handle,
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
    const rooms = [...this.joined.keys()];
    this.joined.clear();
    for (const room of rooms) {
      void this.ensureJoinedRoom(room).catch((err: unknown) => {
        console.error(
          `[parley-xmpp] re-join after reconnect failed for ${room}: ` +
            `${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }
  }

  /** Join a room with NO history (maxstanzas=0); cached so repeated calls are idempotent. */
  private ensureJoined(topic: Topic): Promise<void> {
    return this.ensureJoinedRoom(this.roomJid(topic));
  }

  private ensureJoinedRoom(room: string): Promise<void> {
    const cached = this.joined.get(room);
    if (cached !== undefined) return cached;
    const p = this.doJoin(room);
    this.joined.set(room, p);
    // If the join fails, drop the cache so a later call can retry.
    p.catch(() => {
      if (this.joined.get(room) === p) this.joined.delete(room);
    });
    return p;
  }

  /**
   * Join with bounded retry for the transient cold-creation race: when N instances join a
   * brand-new room at once, exactly one creates it and the rest briefly see `item-not-found`
   * until that creation commits. Retry those; surface anything else.
   */
  private async doJoin(room: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        await this.joinOnce(room);
        return;
      } catch (err) {
        const cond = err instanceof JoinError ? err.condition : undefined;
        if (cond !== undefined && RETRYABLE_CONDITIONS.includes(cond) && attempt < JOIN_RETRIES) {
          await delay(100 + 100 * attempt);
          continue;
        }
        throw err;
      }
    }
  }

  private joinOnce(room: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
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
        resolve: () => settle(resolve),
        reject: (err) => settle(() => reject(err)),
      };
      const timer = setTimeout(
        () => entry.reject(new Error(`MUC join timeout for ${room}`)),
        JOIN_TIMEOUT_MS,
      );
      const superseded = this.pendingJoins.get(room);
      this.pendingJoins.set(room, entry);
      superseded?.reject(new Error(`MUC join superseded for ${room}`));

      const presence = xml(
        'presence',
        { to: `${room}/${this.nick}` },
        xml('x', { xmlns: NS_MUC }, xml('history', { maxstanzas: '0' })),
      );
      this.require()
        .send(presence)
        .catch((err: unknown) => {
          entry.reject(err instanceof Error ? err : new Error(String(err)));
        });
    });
  }

  private roomJid(topic: Topic): string {
    return `${safeName(topic, sanitizeLocal)}@${this.mucService}`;
  }

  private require(): XmppClient {
    if (this.xmpp === undefined) {
      throw new Error('XmppPlugin not connected — call connect() first');
    }
    return this.xmpp;
  }
}

// JID localparts are case-insensitive and may not contain "&'/:<>@ or whitespace; fold to a
// safe, lowercase token. freshTopic() values (t-<n>-<rand>) pass through unchanged.
const sanitizeLocal = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.\-_]/g, '_');
