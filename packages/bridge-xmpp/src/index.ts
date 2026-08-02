import {
  asCursor,
  type BackendConfig,
  type BackendIdentity,
  type BackendMsgId,
  type BackendPlugin,
  type FetchRecentArgs,
  type FetchRecentResult,
  type Handle,
  type MessageHandler,
  type Topic,
} from '@sharptrick/parley-core';
import { client } from '@xmpp/client';
import { randomUUID } from 'node:crypto';

import { MAM_PAGE } from './archive.js';
import {
  DEFAULT_PASSWORD,
  DEFAULT_SERVICE,
  validateBackendConfig,
  warnInsecureConfig,
} from './config.js';
import { rand } from './connection.js';
import { XmppInbound } from './inbound.js';
import * as jid from './jid.js';
import * as wire from './stanzas.js';

export { CONFIG_KEYS, isPlaintextRemote, JID_SIZED_KEYS, validateBackendConfig } from './config.js';
export type { XmppBackendConfig } from './config.js';
export { JID_PART_MAX_BYTES } from './jid.js';
export { REJOIN_MAX_WAIT_MS } from './rooms.js';

const POST_TIMEOUT_MS = 15_000;

const SUPERSEDED_BY_DISCONNECT =
  'parley-xmpp: disconnect() was called while this connect() was still bringing the stream up, so ' +
  'the stream was stopped and this plugin is NOT connected — call connect() again if you want one.';

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
export class XmppPlugin extends XmppInbound implements BackendPlugin {
  async connect(config: BackendConfig): Promise<void> {
    if (this.xmpp !== undefined || this.starting !== undefined) {
      throw new Error(
        'parley-xmpp: already connected (or still connecting) — call disconnect() before connect() ' +
          'again. Taking the second client would abandon the first, which goes on redialling with ' +
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
    this.unprobedRoomsReported.clear();

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
    // Keep the client published in `starting` BEFORE the await, and keep the check that it is still
    // this call's after it, so that a disconnect() landing inside this window has something to stop
    // and cannot be overtaken by a connect() that adopts a stream it already tore down.
    this.starting = xmpp;
    try {
      await xmpp.start();
      if (this.starting !== xmpp) throw new Error(SUPERSEDED_BY_DISCONNECT);
    } catch (err) {
      if (this.starting === xmpp) this.starting = undefined;
      await xmpp.stop().catch(() => undefined);
      throw err;
    }
    this.starting = undefined;
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
    for (const room of [...this.waiters.keys()]) this.fireWaiters(room, 'cancel');
    this.waiters.clear();
    this.forgetAllRooms();
    for (const state of this.rejoins.values()) clearTimeout(state.timer);
    this.rejoins.clear();
    this.mamCheck = undefined;
    this.unprobedRoomsReported.clear();
    // Drop the fields BEFORE awaiting the stop, so that a connect() still bringing `starting` up
    // resumes to find it taken and stops its own client instead of adopting one this call ended.
    const live = this.xmpp ?? this.starting;
    this.xmpp = undefined;
    this.starting = undefined;
    if (live !== undefined) await live.stop().catch(() => undefined);
  }

  /**
   * `<message type='groupchat'>` into the topic's room, resolved by the MUC's own reflection (which
   * carries the archive id). The sender on the wire is this connection's MUC nick, which unless
   * pinned by config is taken from `identity` on the first post (`adoptIdentityNick`).
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
}
