import type { Topic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { expect } from 'vitest';
import type { XmppPlugin } from '../src/index.js';

const NS_MUC = 'http://jabber.org/protocol/muc';
const NS_MUC_USER = 'http://jabber.org/protocol/muc#user';
const NS_DELAY = 'urn:xmpp:delay';
const NS_MAM = 'urn:xmpp:mam:2';
const NS_SID = 'urn:xmpp:sid:0';
const NS_FORWARD = 'urn:xmpp:forward:0';
const NS_RSM = 'http://jabber.org/protocol/rsm';
const NS_STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas';
const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info';

export interface El {
  name: string;
  is(name: string, ns?: string): boolean;
  attrs: Record<string, string>;
  getChild(name: string, ns?: string): El | undefined;
  getChildText(name: string, ns?: string): string | null;
}

export interface ArchiveItem {
  archId: string;
  from: string;
  /** `null` for an archived stanza carrying no `<body>` at all (a subject change, a retraction). */
  body: string | null;
  stamp?: string;
  subject?: string;
}

/** The plugin's private surface, reached by typed cast (the pattern the other suites use). */
export interface XmppPrivate {
  nick: string;
  provisionalNick?: string;
  roomNicks: Map<string, string>;
  mamPage: number;
  nickAdoption?: Promise<void>;
  mamCheck?: Promise<void>;
  stopped: boolean;
  xmpp?: unknown;
  joined: Map<string, Promise<void>>;
  rejoins: Map<string, { losses: number; at: number; timer?: ReturnType<typeof setTimeout> }>;
  pendingJoins: Map<string, { resolve(): void; reject(err: Error): void }>;
  pendingPosts: Map<string, { room: string; resolve(id: unknown): void; reject(err: Error): void }>;
  mamCollectors: Map<string, { room: string; items: ArchiveItem[] }>;
  waiters: Map<string, Set<(reason: string) => void>>;
  subscriptions: Map<string, { topic: Topic; handlers: Array<(m: unknown) => void> }>;
  roomJid(topic: Topic): string;
  joinOnce(room: string): Promise<void>;
  onStanza(stanza: unknown): void;
  armWaiter(room: string): { park(ms: number): Promise<string>; cancel(): void };
  mamQuery(
    topic: Topic,
    opts: { after?: string; before?: boolean; max: number },
  ): Promise<{ items: ArchiveItem[]; complete: boolean }>;
}
export const priv = (p: XmppPlugin): XmppPrivate => p as unknown as XmppPrivate;

/**
 * Every keyed registry the plugin uses to correlate an in-flight operation. A finished operation
 * must leave all of them empty — a survivor is a leaked timer, a stuck long-poll, or a correlator
 * an unrelated later stanza can resolve.
 */
export const expectNoLeaks = (plugin: XmppPlugin): void => {
  const p = priv(plugin);
  expect({
    pendingJoins: p.pendingJoins.size,
    pendingPosts: p.pendingPosts.size,
    mamCollectors: p.mamCollectors.size,
    waiters: p.waiters.size,
  }).toEqual({ pendingJoins: 0, pendingPosts: 0, mamCollectors: 0, waiters: 0 });
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * First codepoint outside XML 1.0's `Char` production, derived independently of the plugin's own
 * check so that a bug in that check cannot make this fixture agree with it.
 */
export const illegalCodepoint = (s: string): number | undefined => {
  for (const ch of s) {
    const cp = ch.codePointAt(0) as number;
    if (cp === 0x9 || cp === 0xa || cp === 0xd) continue;
    if (cp < 0x20 || (cp >= 0xd800 && cp <= 0xdfff) || cp === 0xfffe || cp === 0xffff) return cp;
  }
  return undefined;
};

/**
 * Scriptable stand-in for the `@xmpp/client` surface the plugin uses, built for FAULT injection:
 * per-query latency with hooks at each stage of a MAM round trip, bounced posts, presence errors,
 * silent (never-answered) joins, and synthetic `online`/stream `error` events. The real client is
 * happy-path-only in tests, which is how latency- and error-path defects stayed invisible.
 */
export class FakeXmpp {
  readonly sent: El[] = [];
  /** `Date.now()` of each `sent` stanza, index for index — the only way to assert a send RATE. */
  readonly sentAt: number[] = [];
  readonly archives = new Map<string, ArchiveItem[]>();
  readonly jid = { toString: () => 'parley@parley.local/res' };

  /**
   * Every IQ this connection sent, in order. Recorded on the same list as presences and messages —
   * an IQ is a stanza on the same stream — so a suite that asserts on an outgoing query drives the
   * stand-in that models the server's contract instead of hand-rolling a weaker one.
   */
  get sentIqs(): El[] {
    return this.sent.filter((s) => s.is('iq'));
  }

  /** Latency inserted between a MAM query's archive SNAPSHOT and its `<fin>` (a remote round trip). */
  mamLatencyMs = 0;
  /** Fires when a MAM query arrives, BEFORE it snapshots the archive. */
  onMamRequest?: (room: string) => void | Promise<void>;
  /** Fires AFTER the snapshot while the query is still in flight — anything archived here is invisible to it. */
  onMamInFlight?: (room: string) => void | Promise<void>;

  postReply: 'reflect' | 'error' | 'silent' = 'reflect';
  postErrorCondition = 'not-acceptable';
  postErrorText = '';
  joinReply: 'self' | 'error' | 'silent' = 'self';
  joinErrorCondition = 'conflict';
  joinErrorText = '';
  /** Delay before the MUC answers a join, so a second join can be driven while the first is open. */
  joinLatencyMs = 0;
  /** How many join presences to answer with `joinErrorCondition` before behaving normally. */
  joinErrorsRemaining = 0;
  /**
   * Nicks another occupant already holds: a join asking for one is answered `conflict`, exactly as
   * MUC's unique-nickname rule does. Keyed by NICK rather than by attempt count, so a fixture cannot
   * accidentally make the provisional fallback nick conflict too.
   */
  readonly conflictNicks = new Set<string>();
  /**
   * A nick-locking service (XEP-0045 status 210): the room admits the joiner under a nick of its
   * OWN choosing, and every reflection then comes back from that nick rather than the requested one.
   */
  assignNick?: string;

  /**
   * Rooms that exist. A MUC auto-creates a room on the first join, and only the creator's
   * self-presence carries status 201; `discoUnknownRoom` is what a server answers for a room that
   * was never created.
   */
  readonly rooms = new Set<string>();
  discoUnknownRoom: 'result' | 'item-not-found' = 'result';
  /** Whether a join that CREATES the room says so (status 201), which is what unlocks + configures it. */
  announceCreation = false;

  /** Whether a room's disco#info advertises `urn:xmpp:mam:2` (i.e. muc_mam is loaded). */
  discoMam = true;
  /** Whether the MUC stamps its reflections with a room `<stanza-id>` (i.e. the archive ran). */
  reflectStanzaId = true;
  /** When set, every MAM IQ is answered with this stanza error condition instead of a `<fin/>`. */
  mamIqError?: string;
  /**
   * A MAM peer that never makes progress: every query — whatever `<after>` it carries — is answered
   * with the SAME page, tailed by the id the next `<after>` will therefore repeat, and never marked
   * complete. `bodies: false` makes the items ones the seam does not carry, so a paging loop cannot
   * be rescued by its own body filter either. Only the loop's own advance check can end this.
   */
  nonAdvancingMam?: { bodies: boolean; complete: 'false' | 'omitted' };
  /** Bounce a post to a room this connection is not currently an occupant of, as a MUC does. */
  enforceOccupancy = false;
  /**
   * The condition such a bounce carries. Prosody answers `item-not-found` for a room that is gone
   * and `not-acceptable` for one it no longer holds us in, and ejabberd differs again — so which
   * conditions mean "no longer an occupant" is a table, not a literal.
   */
  occupancyBounceCondition = 'not-acceptable';

  /**
   * A server that ends this connection's occupancy again on EVERY successful join — a moderation
   * bot that kicks the bridge on sight, a members-only room it is not a member of, a MUC component
   * that is shutting down. Set to the presence the server answers with, or `undefined` for a room
   * that keeps the joiner.
   */
  kickOnJoin?: { statuses?: string[]; destroy?: boolean };

  /** The occupant nick a room this connection has not joined here falls back to. */
  nick = 'parley-test';
  /**
   * roomJid -> the nick this connection actually entered THAT room under. Occupancy is per room on a
   * real MUC: one connection can hold `alice` in one room and a fallback nick in another, which is
   * the only state in which a stale connection-wide nick is observable at all. Keep the reflection,
   * the archived sender and the leave presence reading from here, so that a fixture cannot agree
   * with a plugin that lost track of which room it is whom in.
   */
  readonly occupantNicks = new Map<string, string>();
  /** Enforce XML well-formedness on everything sent, as a real XMPP server does. */
  strictXml = true;

  private readonly handlers: Record<string, Array<(a?: unknown) => void>> = {};
  private readonly occupied = new Set<string>();
  private seq = 0;
  private dead = false;

  /** False once a stanza XML forbids has aborted the stream (and every room's archive with it). */
  get alive(): boolean {
    return !this.dead;
  }

  /**
   * An IQ is a stanza on the same stream as everything else, so it gets the same well-formedness
   * enforcement `send` does. Keep them symmetric, so that a field serialised only into an IQ
   * (the RSM `<after>` cursor) cannot be exempt from the check by an accident of the fixture.
   */
  readonly iqCaller = {
    request: (iq: unknown): Promise<unknown> => {
      if (this.dead) return Promise.reject(new Error('stream closed'));
      this.sent.push(iq as El);
      this.sentAt.push(Date.now());
      if (this.strictXml && illegalCodepoint(String(iq)) !== undefined) {
        this.killStream();
        return Promise.reject(new Error('not-well-formed: stream closed'));
      }
      return this.onIq(iq as El);
    },
  };

  on(event: string, cb: (a?: unknown) => void): void {
    (this.handlers[event] ??= []).push(cb);
  }
  emit(event: string, arg?: unknown): void {
    for (const cb of this.handlers[event] ?? []) cb(arg);
  }
  async start(): Promise<void> {}
  async stop(): Promise<void> {}

  /** Push a stanza into the plugin exactly as the stream would. */
  feed(el: unknown): void {
    this.emit('stanza', el);
  }

  async send(el: unknown): Promise<void> {
    if (this.dead) throw new Error('stream closed');
    const stanza = el as El;
    this.sent.push(stanza);
    this.sentAt.push(Date.now());
    if (this.strictXml && illegalCodepoint(String(stanza)) !== undefined) {
      this.killStream();
      throw new Error('not-well-formed: stream closed');
    }
    if (stanza.is('presence')) {
      this.onJoin(stanza);
      return;
    }
    if (stanza.is('message') && stanza.attrs.type === 'groupchat') this.onPost(stanza);
  }

  /**
   * What a real server does with a stanza XML forbids: abort the whole stream. That ends this
   * connection's occupancy in EVERY room at once, and each non-persistent room dies with its
   * archive — so the blast radius is every topic, not the one that was posted to.
   */
  private killStream(): void {
    this.dead = true;
    this.archives.clear();
    this.emit('error', new Error('not-well-formed'));
  }

  /** Archive `body` as if `sender` had said it, and reflect it live (the push + wake path). */
  deliver(room: string, body: string, sender = 'someone'): ArchiveItem {
    return this.deliverItem(room, { body, sender });
  }

  /**
   * Archive an arbitrary stanza shape and reflect it live, so the two paths are driven from ONE
   * description of the stanza. A MUC archives more than chat: a subject change and a retraction
   * carry no `<body>`, and a room-level announcement carries no occupant resource in its `from`.
   */
  deliverItem(
    room: string,
    shape: { body: string | null; subject?: string; sender?: string | null },
  ): ArchiveItem {
    const item = this.archiveItem(room, shape);
    this.feed(
      xml(
        'message',
        { from: item.from, type: 'groupchat' },
        ...(this.itemChildren(item) as never[]),
        xml('stanza-id', { xmlns: NS_SID, by: room, id: item.archId }),
      ),
    );
    return item;
  }

  /** Archive `body` WITHOUT reflecting it (models MAM committing before the live copy lands). */
  archiveOnly(room: string, body: string, sender = 'someone'): ArchiveItem {
    return this.archiveItem(room, { body, sender });
  }

  /** {@link archiveOnly} for a stanza that is not plain chat (see {@link deliverItem}). */
  archiveItem(
    room: string,
    shape: { body: string | null; subject?: string; sender?: string | null },
  ): ArchiveItem {
    const sender = shape.sender === undefined ? 'someone' : shape.sender;
    const item: ArchiveItem = {
      archId: `arch-${++this.seq}`,
      from: sender === null ? room : `${room}/${sender}`,
      body: shape.body,
      subject: shape.subject,
    };
    this.archiveOf(room).push(item);
    return item;
  }

  private itemChildren(item: ArchiveItem): unknown[] {
    return [
      ...(item.body === null ? [] : [xml('body', {}, item.body)]),
      ...(item.subject === undefined ? [] : [xml('subject', {}, item.subject)]),
    ];
  }

  private archiveOf(room: string): ArchiveItem[] {
    this.rooms.add(room); // a room with an archive exists, however the fixture seeded it
    const existing = this.archives.get(room);
    if (existing !== undefined) return existing;
    const fresh: ArchiveItem[] = [];
    this.archives.set(room, fresh);
    return fresh;
  }

  /**
   * End this connection's occupancy of `room` the way a server does when it was not the stream
   * that dropped: a self-directed `<presence type='unavailable'>` carrying the MUC status codes
   * for a kick/ban/affiliation change, or a `<destroy/>` for a room that is gone.
   */
  endOccupancy(room: string, opts: { statuses?: string[]; destroy?: boolean } = {}): void {
    const statuses = opts.statuses ?? [];
    const nick = this.nickIn(room);
    if (!statuses.includes('303')) {
      this.occupied.delete(room);
      this.occupantNicks.delete(room);
    }
    const children = [
      xml('status', { code: '110' }),
      ...statuses.map((code) => xml('status', { code })),
      ...(opts.destroy === true ? [xml('destroy', {})] : []),
    ];
    this.feed(
      xml(
        'presence',
        { from: `${room}/${nick}`, type: 'unavailable' },
        xml('x', { xmlns: NS_MUC_USER }, ...(children as never[])),
      ),
    );
  }

  /** Drop occupancy with NO presence at all, the way a restarted MUC component forgets it. */
  forgetOccupancySilently(room: string): void {
    this.occupied.delete(room);
    this.occupantNicks.delete(room);
  }

  /** Reflect a live message that is NOT (yet) in the archive — a spurious long-poll wake. */
  reflectOnly(room: string, body: string, sender = 'someone'): void {
    this.feed(
      xml(
        'message',
        { from: `${room}/${sender}`, type: 'groupchat' },
        xml('body', {}, body),
        xml('stanza-id', { xmlns: NS_SID, by: room, id: `live-${++this.seq}` }),
      ),
    );
  }

  private onJoin(presence: El): void {
    if (this.joinLatencyMs > 0) {
      setTimeout(() => this.answerJoin(presence), this.joinLatencyMs);
      return;
    }
    this.answerJoin(presence);
  }

  /** The nick this connection holds in `room` — its own occupancy, not the last join anywhere. */
  nickIn(room: string): string {
    return this.occupantNicks.get(room) ?? this.nick;
  }

  private answerJoin(presence: El): void {
    if (this.dead) return;
    const to = presence.attrs.to ?? '';
    const room = to.slice(0, to.indexOf('/'));
    const requested = to.slice(to.indexOf('/') + 1);
    const admitted = this.assignNick ?? requested;
    if (this.joinReply === 'silent') return;
    const taken = this.conflictNicks.has(requested);
    if (taken || this.joinReply === 'error' || this.joinErrorsRemaining > 0) {
      if (!taken && this.joinErrorsRemaining > 0) this.joinErrorsRemaining--;
      this.occupied.delete(room);
      this.feed(
        xml(
          'presence',
          { from: to, type: 'error' },
          taken ? errorEl('conflict') : errorEl(this.joinErrorCondition, this.joinErrorText),
        ),
      );
      return;
    }
    const created = !this.rooms.has(room);
    this.rooms.add(room);
    this.occupied.add(room);
    this.occupantNicks.set(room, admitted);
    this.feed(
      xml(
        'presence',
        { from: `${room}/${admitted}` },
        xml(
          'x',
          { xmlns: NS_MUC_USER },
          xml('status', { code: '110' }),
          ...(this.assignNick !== undefined && this.assignNick !== requested
            ? [xml('status', { code: '210' })]
            : []),
          ...(created && this.announceCreation ? [xml('status', { code: '201' })] : []),
        ),
      ),
    );
    this.replayHistory(room, presence);
    // On its own macrotask, so that a plugin that re-joins without deferring cannot starve the
    // event loop — a storm has to be observable by a timer for a test to bound it.
    if (this.kickOnJoin !== undefined) {
      const kick = this.kickOnJoin;
      setTimeout(() => this.endOccupancy(room, kick), 0);
    }
  }

  /**
   * What a MUC does on join unless the joiner asks for no history: push the room's recent archive
   * back as ordinary live `<message type='groupchat'>` stanzas (XEP-0045 §7.2.15). A plugin that
   * omits `<history maxstanzas='0'/>` therefore re-delivers old messages as new on every re-entry
   * — the reconnect and occupancy-loss paths — so keep this modelled here, so that the join hint
   * is load-bearing rather than decorative.
   */
  private replayHistory(room: string, presence: El): void {
    const requested = presence.getChild('x', NS_MUC)?.getChild('history');
    if (requested?.attrs.maxstanzas === '0') return;
    const max = Number(requested?.attrs.maxstanzas ?? '20');
    for (const item of (this.archives.get(room) ?? []).slice(-max)) {
      this.feed(
        xml(
          'message',
          { from: item.from, type: 'groupchat' },
          ...(this.itemChildren(item) as never[]),
          xml('stanza-id', { xmlns: NS_SID, by: room, id: item.archId }),
          xml('delay', { xmlns: NS_DELAY, stamp: item.stamp ?? new Date().toISOString() }),
        ),
      );
    }
  }

  private onPost(message: El): void {
    const room = message.attrs.to ?? '';
    const originId = message.getChild('origin-id', NS_SID)?.attrs.id ?? message.attrs.id ?? '';
    const body = message.getChildText('body') ?? '';
    if (this.postReply === 'silent') return;
    const notAnOccupant = this.enforceOccupancy && !this.occupied.has(room);
    if (this.postReply === 'error' || notAnOccupant) {
      const condition = notAnOccupant ? this.occupancyBounceCondition : this.postErrorCondition;
      const text = notAnOccupant
        ? 'You are not currently connected to this chat'
        : this.postErrorText;
      this.feed(
        xml(
          'message',
          { from: room, type: 'error', id: originId },
          xml('origin-id', { xmlns: NS_SID, id: originId }),
          errorEl(condition, text),
        ),
      );
      return;
    }
    const item = this.archiveOnly(room, body, this.nickIn(room));
    this.feed(
      xml(
        'message',
        { from: item.from, type: 'groupchat' },
        xml('body', {}, body),
        xml('origin-id', { xmlns: NS_SID, id: originId }),
        ...(this.reflectStanzaId
          ? [xml('stanza-id', { xmlns: NS_SID, by: room, id: item.archId })]
          : []),
      ),
    );
  }

  private async onIq(iq: El): Promise<unknown> {
    if (iq.getChild('query', NS_DISCO_INFO) !== undefined) {
      const room = iq.attrs.to ?? '';
      if (this.discoUnknownRoom === 'item-not-found' && !this.rooms.has(room)) {
        throw stanzaError('item-not-found');
      }
      return xml(
        'iq',
        { type: 'result' },
        xml(
          'query',
          { xmlns: NS_DISCO_INFO },
          xml('feature', { var: 'http://jabber.org/protocol/muc' }),
          ...(this.discoMam ? [xml('feature', { var: NS_MAM })] : []),
        ),
      );
    }
    const query = iq.getChild('query', NS_MAM);
    if (query === undefined) return xml('iq', { type: 'result' });
    if (this.mamIqError !== undefined) throw stanzaError(this.mamIqError);
    const room = iq.attrs.to ?? '';
    const queryid = query.attrs.queryid ?? '';
    await this.onMamRequest?.(room);

    if (this.nonAdvancingMam !== undefined) {
      const { bodies, complete } = this.nonAdvancingMam;
      // A round trip is a macrotask. Keep this yield, so that a plugin looping on these pages
      // starves the timer queue no more than a real server would — without it a paging regression
      // wedges the whole runner instead of failing its own case on the test timeout.
      await sleep(1);
      for (const archId of ['stuck-a', 'stuck-b']) {
        this.feedMamResult(room, queryid, { archId, from: `${room}/x`, body: bodies ? 'x' : null });
      }
      return xml(
        'iq',
        { type: 'result' },
        xml('fin', { xmlns: NS_MAM, ...(complete === 'omitted' ? {} : { complete: 'false' }) }),
      );
    }

    const set = query.getChild('set', NS_RSM);
    const after = set?.getChildText('after');
    const max = Number(set?.getChildText('max') ?? '50');
    const all = this.archives.get(room) ?? [];
    let start: number;
    if (set?.getChild('before') !== undefined) {
      start = Math.max(0, all.length - max);
    } else {
      // An <after> the archive does not hold replays from the start — Prosody's actual behaviour.
      start = after !== null && after !== undefined ? all.findIndex((i) => i.archId === after) + 1 : 0;
    }
    const window = all.slice(start, start + max);
    const complete = start + window.length >= all.length;

    await this.onMamInFlight?.(room);
    if (this.mamLatencyMs > 0) await sleep(this.mamLatencyMs);
    for (const item of window) this.feedMamResult(room, queryid, item);
    return xml(
      'iq',
      { type: 'result' },
      xml('fin', { xmlns: NS_MAM, complete: String(complete) }),
    );
  }

  /** One streamed `<result>` of a MAM page — the shape every archived stanza comes back in. */
  private feedMamResult(room: string, queryid: string, item: ArchiveItem): void {
    this.feed(
      xml(
        'message',
        { from: room },
        xml(
          'result',
          { xmlns: NS_MAM, queryid, id: item.archId },
          xml(
            'forwarded',
            { xmlns: NS_FORWARD },
            xml('message', { from: item.from }, ...(this.itemChildren(item) as never[])),
          ),
        ),
      ),
    );
  }
}

/** What `@xmpp/iq`'s caller rejects an errored IQ with: an Error carrying the defined condition. */
const stanzaError = (condition: string): Error =>
  Object.assign(new Error(condition), { condition });

export const errorEl = (condition: string, text = ''): unknown =>
  xml(
    'error',
    { type: 'cancel' },
    xml(condition, { xmlns: NS_STANZAS }),
    ...(text !== '' ? [xml('text', { xmlns: NS_STANZAS }, text)] : []),
  );

/**
 * A plugin wired to `fake`, with the MUC handshake for `room` already satisfied. The occupant nick
 * is assigned here, so it is also PINNED here — otherwise the first `post` would take its
 * `identity` argument as the nick and this fixture's `fake.nick` would be a lie one stanza later.
 * Suites about nick adoption drive `connect()` instead.
 */
export const attach = (plugin: XmppPlugin, fake: FakeXmpp, room?: string): XmppPrivate => {
  const p = priv(plugin);
  p.xmpp = fake;
  p.nick = fake.nick;
  p.nickAdoption = Promise.resolve();
  fake.on('stanza', (stanza) => p.onStanza(stanza)); // the wiring connect() does
  if (room !== undefined) {
    p.joined.set(room, Promise.resolve());
    fake.rooms.add(room);
    fake.occupantNicks.set(room, fake.nick);
  }
  return p;
};
