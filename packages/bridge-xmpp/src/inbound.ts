import { asBackendMsgId, type BackendMsgId } from '@sharptrick/parley-core';

import { MAM_MISSING_HINT } from './archive.js';
import * as jid from './jid.js';
import { NOT_AN_OCCUPANT_CONDITIONS, XmppRooms } from './rooms.js';
import * as wire from './stanzas.js';

interface PendingPost {
  /** The room this post was sent to; only its own reflection may resolve the correlator. */
  room: string;
  resolve(id: BackendMsgId): void;
  reject(err: Error): void;
}

export class XmppInbound extends XmppRooms {
  /** origin-id -> resolver awaiting the MUC reflection that carries the archive id. */
  protected readonly pendingPosts = new Map<string, PendingPost>();

  protected onStanza(stanza: wire.El): void {
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

    if (stanza.attrs.type === 'error') this.onErrorMessage(stanza);
    else if (stanza.attrs.type === 'groupchat') this.onGroupchat(stanza);
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
    this.fireWaiters(room, 'message');
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

  /**
   * A reconnect restores the stream but not MUC occupancy — that is presence, and the library does
   * not re-send it. Re-drive every room in `joined`, not just the subscribed ones, so that a
   * catch-up-only topic is not left silently outside its room until some later post re-enters it.
   */
  protected rejoinAfterReconnect(): void {
    for (const pp of this.pendingPosts.values()) pp.reject(new Error('reconnected; retry post'));
    this.pendingPosts.clear();
    for (const room of this.forgetAllRooms()) this.redriveJoin(room, 'reconnect');
  }
}
