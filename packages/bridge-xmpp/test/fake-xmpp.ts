import type { Topic } from '@sharptrick/parley-core';
import { xml } from '@xmpp/client';
import { expect } from 'vitest';
import type { XmppPlugin } from '../src/index.js';

const NS_MUC_USER = 'http://jabber.org/protocol/muc#user';
const NS_MAM = 'urn:xmpp:mam:2';
const NS_SID = 'urn:xmpp:sid:0';
const NS_FORWARD = 'urn:xmpp:forward:0';
const NS_RSM = 'http://jabber.org/protocol/rsm';
const NS_STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas';

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
  body: string;
}

/** The plugin's private surface, reached by typed cast (the pattern the other suites use). */
export interface XmppPrivate {
  nick: string;
  stopped: boolean;
  xmpp?: unknown;
  joined: Map<string, Promise<void>>;
  pendingJoins: Map<string, { resolve(): void; reject(err: Error): void }>;
  pendingPosts: Map<string, { room: string; resolve(id: unknown): void; reject(err: Error): void }>;
  mamCollectors: Map<string, { room: string; items: ArchiveItem[] }>;
  waiters: Map<string, Set<(reason: string) => void>>;
  subscriptions: Map<string, { topic: Topic; handlers: Array<(m: unknown) => void> }>;
  roomJid(topic: Topic): string;
  joinOnce(room: string): Promise<void>;
  onStanza(stanza: unknown): void;
  armWaiter(room: string, blockMs: number): { fired: Promise<string>; cancel(): void };
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
 * Scriptable stand-in for the `@xmpp/client` surface the plugin uses, built for FAULT injection:
 * per-query latency with hooks at each stage of a MAM round trip, bounced posts, presence errors,
 * silent (never-answered) joins, and synthetic `online`/stream `error` events. The real client is
 * happy-path-only in tests, which is how latency- and error-path defects stayed invisible.
 */
export class FakeXmpp {
  readonly sent: El[] = [];
  readonly archives = new Map<string, ArchiveItem[]>();
  readonly jid = { toString: () => 'parley@parley.local/res' };

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

  /** The occupant nick the plugin joined with; a reflection must come back from it. */
  nick = 'parley-test';

  private readonly handlers: Record<string, Array<(a?: unknown) => void>> = {};
  private seq = 0;

  readonly iqCaller = { request: (iq: unknown): Promise<unknown> => this.onIq(iq as El) };

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
    const stanza = el as El;
    this.sent.push(stanza);
    if (stanza.is('presence')) {
      this.onJoin(stanza);
      return;
    }
    if (stanza.is('message') && stanza.attrs.type === 'groupchat') this.onPost(stanza);
  }

  /** Archive `body` as if `sender` had said it, and reflect it live (the push + wake path). */
  deliver(room: string, body: string, sender = 'someone'): ArchiveItem {
    const item = this.archiveOnly(room, body, sender);
    this.feed(
      xml(
        'message',
        { from: item.from, type: 'groupchat' },
        xml('body', {}, body),
        xml('stanza-id', { xmlns: NS_SID, by: room, id: item.archId }),
      ),
    );
    return item;
  }

  /** Archive `body` WITHOUT reflecting it (models MAM committing before the live copy lands). */
  archiveOnly(room: string, body: string, sender = 'someone'): ArchiveItem {
    const item = { archId: `arch-${++this.seq}`, from: `${room}/${sender}`, body };
    this.archiveOf(room).push(item);
    return item;
  }

  private archiveOf(room: string): ArchiveItem[] {
    const existing = this.archives.get(room);
    if (existing !== undefined) return existing;
    const fresh: ArchiveItem[] = [];
    this.archives.set(room, fresh);
    return fresh;
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
    const to = presence.attrs.to ?? '';
    this.nick = to.slice(to.indexOf('/') + 1);
    if (this.joinReply === 'silent') return;
    if (this.joinReply === 'error') {
      this.feed(
        xml(
          'presence',
          { from: to, type: 'error' },
          errorEl(this.joinErrorCondition, this.joinErrorText),
        ),
      );
      return;
    }
    this.feed(
      xml(
        'presence',
        { from: to },
        xml('x', { xmlns: NS_MUC_USER }, xml('status', { code: '110' })),
      ),
    );
  }

  private onPost(message: El): void {
    const room = message.attrs.to ?? '';
    const originId = message.getChild('origin-id', NS_SID)?.attrs.id ?? message.attrs.id ?? '';
    const body = message.getChildText('body') ?? '';
    if (this.postReply === 'silent') return;
    if (this.postReply === 'error') {
      this.feed(
        xml(
          'message',
          { from: room, type: 'error', id: originId },
          xml('origin-id', { xmlns: NS_SID, id: originId }),
          errorEl(this.postErrorCondition, this.postErrorText),
        ),
      );
      return;
    }
    const item = this.archiveOnly(room, body, this.nick);
    this.feed(
      xml(
        'message',
        { from: item.from, type: 'groupchat' },
        xml('body', {}, body),
        xml('origin-id', { xmlns: NS_SID, id: originId }),
        xml('stanza-id', { xmlns: NS_SID, by: room, id: item.archId }),
      ),
    );
  }

  private async onIq(iq: El): Promise<unknown> {
    const query = iq.getChild('query', NS_MAM);
    if (query === undefined) return xml('iq', { type: 'result' });
    const room = iq.attrs.to ?? '';
    const queryid = query.attrs.queryid ?? '';
    await this.onMamRequest?.(room);

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
    for (const item of window) {
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
              xml('message', { from: item.from }, xml('body', {}, item.body)),
            ),
          ),
        ),
      );
    }
    return xml(
      'iq',
      { type: 'result' },
      xml('fin', { xmlns: NS_MAM, complete: String(complete) }),
    );
  }
}

export const errorEl = (condition: string, text = ''): unknown =>
  xml(
    'error',
    { type: 'cancel' },
    xml(condition, { xmlns: NS_STANZAS }),
    ...(text !== '' ? [xml('text', { xmlns: NS_STANZAS }, text)] : []),
  );

/** A plugin wired to `fake`, with the MUC handshake for `room` already satisfied. */
export const attach = (plugin: XmppPlugin, fake: FakeXmpp, room?: string): XmppPrivate => {
  const p = priv(plugin);
  p.xmpp = fake;
  p.nick = fake.nick;
  fake.on('stanza', (stanza) => p.onStanza(stanza)); // the wiring connect() does
  if (room !== undefined) p.joined.set(room, Promise.resolve());
  return p;
};
