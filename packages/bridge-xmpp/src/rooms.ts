import type { Handle, MessageHandler, Topic } from '@sharptrick/parley-core';
import { delay } from '@sharptrick/parley-net-util';

import { MAM_MISSING_HINT, MAM_TIMEOUT_MS, XmppArchive } from './archive.js';
import * as jid from './jid.js';
import * as wire from './stanzas.js';

const JOIN_TIMEOUT_MS = 15_000;
const DISCO_TIMEOUT_MS = 5_000;
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
export const NOT_AN_OCCUPANT_CONDITIONS = ['not-acceptable', 'gone', 'item-not-found', 'recipient-unavailable'];

interface PendingJoin {
  /** The nick this join's presence was addressed to; only a presence naming it (or one carrying
   * XEP-0045 status 210) can be attributed to it. */
  nick: string;
  resolve(): void;
  reject(err: Error): void;
  /** Hand this entry's outcome to a successor join for the same room ({@link XmppRooms.joinOnce}). */
  settleFrom(outcome: Promise<void>): void;
}

export class XmppRooms extends XmppArchive {
  /** Memoized disco#info probe for the one prerequisite this backend cannot work without. */
  protected mamCheck?: Promise<void>;

  /** roomJid -> consecutive remote occupancy losses and the deferred re-entry they scheduled. */
  protected readonly rejoins = new Map<
    string,
    { losses: number; at: number; timer?: ReturnType<typeof setTimeout> }
  >();
  protected readonly pendingJoins = new Map<string, PendingJoin>();
  protected readonly subscriptions = new Map<string, { topic: Topic; handlers: MessageHandler[] }>();

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
  protected onOccupancyLost(room: string, why: string): void {
    if (this.stopped) return;
    if (!this.joined.has(room) || this.pendingJoins.has(room)) return;
    this.forgetRoom(room);

    const now = Date.now();
    const prior = this.rejoins.get(room);
    clearTimeout(prior?.timer);
    const losses = prior !== undefined && now - prior.at < REJOIN_WINDOW_MS ? prior.losses + 1 : 1;
    this.rejoins.set(room, { losses, at: now });

    if (!this.subscriptions.has(room)) {
      console.error(`[parley-xmpp] occupancy in ${room} ended (${why})`);
      return;
    }
    if (losses > REJOIN_LIMIT) {
      console.error(
        `[parley-xmpp] occupancy in ${room} ended (${why}) ${losses} consecutive times, each ` +
          `within ${REJOIN_WINDOW_MS} ms of the previous — not re-entering it again; live push for ` +
          'this topic stays dead until a post or fetchRecent re-enters the room',
      );
      return;
    }
    const wait = REJOIN_BASE_MS * 2 ** (losses - 1) + Math.floor(Math.random() * REJOIN_BASE_MS);
    console.error(`[parley-xmpp] occupancy in ${room} ended (${why}); re-joining in ${wait} ms`);
    const timer = setTimeout(() => {
      if (!this.stopped && this.subscriptions.has(room)) this.redriveJoin(room, 'losing occupancy');
    }, wait);
    this.rejoins.set(room, { losses, at: now, timer });
  }

  /** Re-enter `room` in the background, reporting a failure rather than swallowing the rejection. */
  protected redriveJoin(room: string, after: string): void {
    void this.ensureJoinedRoom(room).catch((err: unknown) => {
      console.error(`[parley-xmpp] re-join after ${after} failed for ${room}: ${wire.asError(err).message}`);
    });
  }

  /**
   * Unlock a room we just created, asking for a PERSISTENT one: a non-persistent MUC and its archive
   * die with the last occupant, which every stream drop causes — so catch-up cannot survive a blip.
   */
  protected async configureRoom(room: string): Promise<void> {
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
  protected adoptIdentityNick(identity: Handle): Promise<void> {
    const wanted = jid.nickFor(identity);
    if (this.nickAdoption === undefined) {
      this.adoptedNick = wanted;
      this.nickAdoption = this.switchNick(wanted);
    } else if (this.adoptedNick !== undefined && wanted !== this.adoptedNick && !this.identityCollapseReported) {
      this.identityCollapseReported = true;
      console.error(
        `[parley-xmpp] this connection posts as '${this.adoptedNick}' (taken from the first post's ` +
          `identity.handle), so a post under '${wanted}' is archived — and read back — as ` +
          `'${this.adoptedNick}'. One MUC occupant is one sender: run one bridge per handle, or ` +
          'pin backend_config.nick, if the two must stay distinct.',
      );
    }
    return this.nickAdoption;
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
  protected async roomExists(topic: Topic): Promise<boolean> {
    const room = this.roomJid(topic);
    if (this.joined.has(room)) return true;
    try {
      await this.require().iqCaller.request(wire.discoInfoIq(room), DISCO_TIMEOUT_MS);
      return true;
    } catch (err) {
      return wire.conditionOf(err) !== 'item-not-found';
    }
  }

  protected ensureJoinedRoom(room: string): Promise<void> {
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
      const timer = setTimeout(() => entry.reject(new Error(`MUC join timeout for ${room}`)), JOIN_TIMEOUT_MS);
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
}
