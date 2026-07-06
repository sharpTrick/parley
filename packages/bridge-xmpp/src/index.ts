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
// `@xmpp/client` re-exports `xml` (the ltx element factory). Importing from the one
// declared dependency keeps the package self-contained (no extra direct dep on @xmpp/xml).
import { client, xml } from '@xmpp/client';

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
const NS_XDATA = 'jabber:x:data';

const JOIN_TIMEOUT_MS = 15_000;
const POST_TIMEOUT_MS = 15_000;
const MAM_TIMEOUT_MS = 15_000;
/** Page size for forward MAM paging; the conformance scale fits one page, big archives won't. */
const MAM_PAGE = 200;
/** Bounded retry for the transient MUC cold-creation race (see {@link XmppPlugin.doJoin}). */
const JOIN_RETRIES = 8;
/** Conditions that mean "room not committed yet" — retryable during concurrent cold-start. */
const RETRYABLE_CONDITIONS = ['item-not-found', 'recipient-unavailable', 'remote-server-not-found'];

const rand = (): string => Math.random().toString(36).slice(2, 12);
const resourceOf = (full: string): string => {
  const i = full.indexOf('/');
  return i === -1 ? '' : full.slice(i + 1);
};
const bareOf = (full: string): string => {
  const i = full.indexOf('/');
  return i === -1 ? full : full.slice(0, i);
};

/** A minimal view of the ltx element / @xmpp client surface we use (no upstream types ship). */
type El = {
  is(name: string, ns?: string): boolean;
  attrs: Record<string, string>;
  getChild(name: string, ns?: string): El | undefined;
  getChildren(name: string, ns?: string): El[];
  getChildText(name: string, ns?: string): string | null;
};
type XmppClient = {
  jid?: { toString(): string };
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  send(el: unknown): Promise<unknown>;
  on(event: string, cb: (arg: El) => void): void;
  iqCaller: { request(el: unknown, timeout?: number): Promise<El> };
};

/** Carries the XMPP error condition so the join loop can decide whether to retry. */
class JoinError extends Error {
  constructor(
    readonly condition: string,
    room: string,
  ) {
    super(`MUC join error (${condition}) for ${room}`);
  }
}

interface PendingJoin {
  resolve(): void;
  reject(err: Error): void;
}
interface PendingPost {
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

  /** roomJid -> in-flight/settled join (cached like an "ensure"; idempotent). */
  private readonly joined = new Map<string, Promise<void>>();
  private readonly pendingJoins = new Map<string, PendingJoin>();
  /** origin-id -> resolver awaiting the MUC reflection that carries the archive id. */
  private readonly pendingPosts = new Map<string, PendingPost>();
  /** MAM queryid -> collector for the streamed `<result>` items. */
  private readonly mamCollectors = new Map<string, MamItem[]>();
  /** roomJid -> live subscription(s). */
  private readonly subscriptions = new Map<string, Subscription>();

  async connect(config: BackendConfig): Promise<void> {
    const cfg = config as XmppBackendConfig;
    this.domain = cfg.domain ?? 'parley.local';
    this.mucService = cfg.muc_service ?? 'muc.parley.local';
    const username = cfg.username ?? 'parley';
    this.handle = username;
    this.nick = cfg.nick ?? `${username}-${rand()}`;
    this.stopped = false;

    // SEC-06: warn loudly before the SASL handshake when the operator is connecting with the
    // repo-public default password (unset → fell back, or set literally to the well-known value).
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
    // Stream/connection errors surface via command rejections; don't crash the process.
    xmpp.on('error', () => undefined);
    xmpp.on('stanza', (stanza) => this.onStanza(stanza));
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
    this.joined.clear();
    if (this.xmpp !== undefined) {
      await this.xmpp.stop().catch(() => undefined);
      this.xmpp = undefined;
    }
  }

  async post(
    topic: Topic,
    _identity: Handle,
    content: string,
    _opts?: { inReplyTo?: BackendMsgId },
  ): Promise<BackendMsgId> {
    await this.ensureJoined(topic);
    const room = this.roomJid(topic);
    const originId = `o-${rand()}${rand()}`;

    const promise = new Promise<BackendMsgId>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingPosts.delete(originId);
        reject(new Error(`post reflection timeout in ${room}`));
      }, POST_TIMEOUT_MS);
      this.pendingPosts.set(originId, {
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

    let items: MamItem[];
    if (args.since === undefined) {
      // Default window: the most recent `limit` messages (RSM "last page" via empty <before/>).
      items = (await this.mamQuery(args.topic, { before: true, max: limit })).items;
    } else {
      // Exclusive catch-up: page forward with <after> until complete or `limit` reached.
      items = [];
      let cursor = String(args.since);
      while (items.length < limit) {
        const page = await this.mamQuery(args.topic, {
          after: cursor,
          max: Math.min(MAM_PAGE, limit - items.length),
        });
        items.push(...page.items);
        if (page.complete || page.items.length === 0) break;
        cursor = page.items[page.items.length - 1]!.archId;
      }
    }

    const messages = items.map((it) => this.toMessage(args.topic, it));
    const last = messages.at(-1);
    const nextCursor = last !== undefined ? last.cursor : (args.since ?? asCursor(''));
    return { messages, nextCursor };
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
      this.onMamResult(result);
      return;
    }

    if (stanza.attrs.type !== 'groupchat') return;
    this.onGroupchat(stanza);
  }

  private onPresence(stanza: El): void {
    const from = stanza.attrs.from ?? '';
    const room = bareOf(from);
    const pending = this.pendingJoins.get(room);
    if (pending === undefined) return;

    if (stanza.attrs.type === 'error') {
      this.pendingJoins.delete(room);
      const errEl = stanza.getChild('error');
      const cond = RETRYABLE_CONDITIONS.find((c) => errEl?.getChild(c) !== undefined) ?? 'error';
      pending.reject(new JoinError(cond, room));
      return;
    }
    // Self-presence: our own nick echoed back, or status code 110.
    const x = stanza.getChild('x', NS_MUC_USER);
    const statuses = x?.getChildren('status') ?? [];
    const isSelf =
      resourceOf(from) === this.nick || statuses.some((s) => s.attrs.code === '110');
    if (!isSelf) return;
    this.pendingJoins.delete(room);
    // Status 201 = we just CREATED the room; it is locked until the owner submits config.
    // Unlock it (accept defaults = "instant room") so concurrent joiners aren't item-not-found.
    if (statuses.some((s) => s.attrs.code === '201')) {
      this.unlockRoom(room).finally(() => pending.resolve());
    } else {
      pending.resolve();
    }
  }

  /** Accept the default room configuration ("instant room", XEP-0045 §10.1.2) to unlock it. */
  private async unlockRoom(room: string): Promise<void> {
    const iq = xml(
      'iq',
      { type: 'set', to: room },
      xml('query', { xmlns: NS_MUC_OWNER }, xml('x', { xmlns: NS_XDATA, type: 'submit' })),
    );
    await this.require()
      .iqCaller.request(iq, MAM_TIMEOUT_MS)
      .catch(() => undefined);
  }

  private onMamResult(result: El): void {
    const collector = this.mamCollectors.get(result.attrs.queryid ?? '');
    if (collector === undefined) return;
    const forwarded = result.getChild('forwarded', NS_FORWARD);
    const inner = forwarded?.getChild('message');
    if (inner === undefined) return;
    const delay = forwarded?.getChild('delay', NS_DELAY);
    collector.push({
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

    // Correlate our own post() by its origin-id; resolve with the server's archive id.
    const originId = stanza.getChild('origin-id', NS_SID)?.attrs.id;
    if (originId !== undefined) {
      const pending = this.pendingPosts.get(originId);
      if (pending !== undefined && archId !== undefined) {
        this.pendingPosts.delete(originId);
        pending.resolve(asBackendMsgId(archId));
      }
    }

    // Live delivery: every reflected message carrying a room stanza-id (incl. our own).
    if (archId === undefined) return;
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
    const queryid = `q-${rand()}`;
    const collector: MamItem[] = [];
    this.mamCollectors.set(queryid, collector);

    const rsm: unknown[] = [];
    if (opts.after !== undefined) rsm.push(xml('after', {}, opts.after));
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

  /** Join a room with NO history (maxstanzas=0); cached so repeated calls are idempotent. */
  private ensureJoined(topic: Topic): Promise<void> {
    const room = this.roomJid(topic);
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
      const timer = setTimeout(() => {
        this.pendingJoins.delete(room);
        reject(new Error(`MUC join timeout for ${room}`));
      }, JOIN_TIMEOUT_MS);
      this.pendingJoins.set(room, {
        resolve: () => {
          clearTimeout(timer);
          resolve();
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
      });
      const presence = xml(
        'presence',
        { to: `${room}/${this.nick}` },
        xml('x', { xmlns: NS_MUC }, xml('history', { maxstanzas: '0' })),
      );
      this.require()
        .send(presence)
        .catch((err: unknown) => {
          const pj = this.pendingJoins.get(room);
          if (pj !== undefined) {
            this.pendingJoins.delete(room);
            pj.reject(err instanceof Error ? err : new Error(String(err)));
          }
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
