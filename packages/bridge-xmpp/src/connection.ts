import { buildMessage, type Message, type Topic } from '@sharptrick/parley-core';
import { randomBytes } from 'node:crypto';

import * as jid from './jid.js';
import * as wire from './stanzas.js';

/** Floor between two stream-error reports, so a reconnect storm can't flood stderr. */
const STREAM_ERROR_LOG_MS = 5_000;

// Correlators (origin-id, nick) are published in the room on every post, so a co-occupant sees
// them: keep this crypto-random, or an observer can predict the next one and race the reflection.
export const rand = (): string => randomBytes(8).toString('hex');

export class XmppConnection {
  protected xmpp?: wire.XmppClient;
  /**
   * The client a `connect()` is bringing up but has not adopted yet. It is live from construction
   * (`@xmpp/reconnect` dials on its own), so it is published here rather than left on `connect`'s
   * stack: this is the ONLY handle a `disconnect()` racing that call has on the stream it must stop,
   * and clearing it is how that `disconnect()` tells the racing `connect()` it lost.
   */
  protected starting?: wire.XmppClient;
  protected mucService = 'muc.parley.local';
  protected handle = 'parley';
  protected nick = `parley-${rand()}`;
  /** The fallback for a nick another occupant already holds; `undefined` when config pinned one. */
  protected provisionalNick?: string;
  protected stopped = false;
  private lastStreamErrorAt = 0;
  /** Settled once the occupant nick is final: pinned by config, or taken from `post`'s identity. */
  protected nickAdoption?: Promise<void>;
  /** The nick taken from the FIRST post's identity; `undefined` when config pinned one instead. */
  protected adoptedNick?: string;
  /** The nick a room last ADMITTED this connection under, which is not always the one it asked for. */
  protected admittedNick?: string;
  protected identityCollapseReported = false;

  /** roomJid -> in-flight/settled join (cached like an "ensure"; idempotent). */
  protected readonly joined = new Map<string, Promise<void>>();
  /**
   * roomJid -> the occupant nick this connection actually holds there, once it differs from
   * {@link nick}. Keyed per room, so that one room's nick cannot make this connection's reflections
   * in every OTHER room fail the provenance check in `onGroupchat` and stall every post there.
   */
  protected readonly roomNicks = new Map<string, string>();

  protected reportStreamError(err: unknown): void {
    const now = Date.now();
    if (now - this.lastStreamErrorAt < STREAM_ERROR_LOG_MS) return;
    this.lastStreamErrorAt = now;
    console.error(`[parley-xmpp] stream error: ${wire.asError(err).message}`);
  }

  protected toMessage(topic: Topic, it: wire.BodiedItem): Message {
    return buildMessage({
      topic,
      sender: jid.senderOf(it.from, this.handle),
      content: it.body,
      timestamp: it.stamp ?? new Date().toISOString(),
      id: it.archId,
    });
  }

  /**
   * Fall back to the nick this connection started with when another occupant holds the one it asked
   * for, while `joiningRoom` is the room whose join was answered `conflict`. A pinned
   * `backend_config.nick`, or a conflict on the provisional nick itself, has no fallback left and
   * leaves the nick alone so the condition surfaces.
   *
   * Keep every OTHER room this connection occupies on the nick it entered under: dropping the
   * connection-wide nick out from under it would make its own reflections fail the provenance check
   * in `onGroupchat`, and every post there would stall to `POST_TIMEOUT_MS` with nothing left
   * to re-reconcile it.
   */
  protected revertToProvisionalNick(joiningRoom: string): void {
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

  protected occupantNick(room: string): string {
    return this.roomNicks.get(room) ?? this.nick;
  }

  protected forgetRoom(room: string): void {
    this.joined.delete(room);
    this.roomNicks.delete(room);
  }

  /** Drop every join, returning the rooms that have to be re-entered. */
  protected forgetAllRooms(): string[] {
    const rooms = [...this.joined.keys()];
    this.joined.clear();
    this.roomNicks.clear();
    return rooms;
  }

  protected roomJid(topic: Topic): string {
    return `${jid.roomLocalpart(topic)}@${this.mucService}`;
  }

  protected require(): wire.XmppClient {
    if (this.stopped || this.xmpp === undefined) {
      throw new Error('XmppPlugin not connected — call connect() first');
    }
    return this.xmpp;
  }
}
