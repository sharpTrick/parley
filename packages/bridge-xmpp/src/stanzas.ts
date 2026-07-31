import { xml } from '@xmpp/client';

/** A minimal view of the ltx element / @xmpp client surface we use (no upstream types ship). */
export type El = {
  name: string;
  is(name: string, ns?: string): boolean;
  attrs: Record<string, string>;
  children: Array<El | string>;
  getChild(name: string, ns?: string): El | undefined;
  getChildren(name: string, ns?: string): El[];
  getChildText(name: string, ns?: string): string | null;
};
export type XmppClient = {
  jid?: { toString(): string };
  start(): Promise<unknown>;
  stop(): Promise<unknown>;
  send(el: unknown): Promise<unknown>;
  on(event: string, cb: (arg?: unknown) => void): void;
  iqCaller: { request(el: unknown, timeout?: number): Promise<El> };
};

/** XML namespaces: XEP-0045 MUC, XEP-0313 MAM, XEP-0359 SID, XEP-0297 forward, XEP-0203 delay, RSM. */
const NS_MUC = 'http://jabber.org/protocol/muc';
export const NS_MUC_USER = 'http://jabber.org/protocol/muc#user';
export const NS_MAM = 'urn:xmpp:mam:2';
export const NS_SID = 'urn:xmpp:sid:0';
const NS_FORWARD = 'urn:xmpp:forward:0';
const NS_DELAY = 'urn:xmpp:delay';
const NS_RSM = 'http://jabber.org/protocol/rsm';
const NS_MUC_OWNER = 'http://jabber.org/protocol/muc#owner';
const NS_ROOMCONFIG = 'http://jabber.org/protocol/muc#roomconfig';
const NS_XDATA = 'jabber:x:data';
const NS_STANZAS = 'urn:ietf:params:xml:ns:xmpp-stanzas';
const NS_DISCO_INFO = 'http://jabber.org/protocol/disco#info';

/** XEP-0045 §7.6: our own occupant going unavailable to take a NEW nick, not to leave. */
export const STATUS_NICK_CHANGE = '303';
/** XEP-0045 §7.2.2: this presence is about the recipient's own occupant. */
export const STATUS_SELF_PRESENCE = '110';
/** XEP-0045 §7.2.3: the service admitted this occupant under a nick of its OWN choosing. */
export const STATUS_SERVICE_ASSIGNED_NICK = '210';
/** XEP-0045 §10.1.1: this join CREATED the room, which stays locked until its owner configures it. */
export const STATUS_ROOM_CREATED = '201';
/** XEP-0045 status codes that explain why our occupancy ended (kick, ban, affiliation, shutdown). */
const OCCUPANCY_END_STATUS: Record<string, string> = {
  '301': 'banned',
  '307': 'kicked',
  '321': 'affiliation change',
  '322': 'room became members-only',
  '332': 'MUC service shutting down',
  '333': 'occupant technical error',
};

export const occupancyEndReason = (statuses: string[], x: El | undefined): string => {
  const named = statuses.map((c) => OCCUPANCY_END_STATUS[c]).filter((s) => s !== undefined);
  if (x?.getChild('destroy') !== undefined) named.push('room destroyed');
  return named.length > 0 ? named.join(', ') : 'left the room';
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
/**
 * A stanza carrying a codepoint XML forbids is not rejected per-stanza: the server aborts the whole
 * stream with `not-well-formed`, which ends MUC occupancy for EVERY room this connection serves.
 * Keep every string that reaches the wire behind this check, so that one topic's payload cannot
 * take down the others.
 */
export const assertXmlSafe = (value: string, what: string): void => {
  const cp = xmlIllegalCodepoint(value);
  if (cp !== undefined) {
    throw new Error(
      `${what} contains U+${cp.toString(16).toUpperCase().padStart(4, '0')}, which XML forbids — ` +
        'refusing to send it (the server would abort the stream and every MUC room this ' +
        'connection occupies with it)',
    );
  }
};

/** The RFC 6120 §8.3 defined-condition child of a stanza's `<error>`, plus its optional `<text>`. */
export const stanzaError = (stanza: El): { condition: string; text: string } => {
  const err = stanza.getChild('error');
  if (err === undefined) return { condition: 'error', text: '' };
  const defined = err.children.find((c): c is El => typeof c !== 'string' && c.name !== 'text');
  return {
    condition: defined?.name ?? err.attrs.type ?? 'error',
    text: err.getChildText('text', NS_STANZAS) ?? err.getChildText('text') ?? '',
  };
};
export const describeError = (e: { condition: string; text: string }): string =>
  e.text !== '' ? `${e.condition}: ${e.text}` : e.condition;

export const asError = (err: unknown): Error => (err instanceof Error ? err : new Error(String(err)));
export const conditionOf = (err: unknown): string =>
  typeof (err as { condition?: unknown })?.condition === 'string'
    ? (err as { condition: string }).condition
    : asError(err).message;

/** Carries the XMPP error condition so the join loop can decide whether to retry. */
export class JoinError extends Error {
  constructor(
    readonly condition: string,
    room: string,
    text = '',
  ) {
    super(`MUC join error (${describeError({ condition, text })}) for ${room}`);
  }
}

/** One row of a room's archive, as XEP-0313 hands it over. */
export interface MamItem {
  archId: string;
  from: string;
  /** `null` for a stanza with no `<body>` at all — a subject change, a retraction, a chat state. */
  body: string | null;
  stamp?: string;
}
/** A {@link MamItem} the seam can carry: the live path admits exactly these, so catch-up must too. */
export type BodiedItem = MamItem & { body: string };
export const hasBody = (it: MamItem): it is BodiedItem => it.body !== null;

/** The archived message inside a MAM `<result>`, or `undefined` when it forwards no message. */
export const archivedItem = (result: El): MamItem | undefined => {
  const forwarded = result.getChild('forwarded', NS_FORWARD);
  const inner = forwarded?.getChild('message');
  if (inner === undefined) return undefined;
  return {
    archId: result.attrs.id ?? '',
    from: inner.attrs.from ?? '',
    body: inner.getChild('body') === undefined ? null : (inner.getChildText('body') ?? ''),
    stamp: forwarded?.getChild('delay', NS_DELAY)?.attrs.stamp,
  };
};

/**
 * The `<delay>` stamp on a live stanza, and only the room's own: XEP-0203 §4 puts the entity that
 * added the delay in `from`, and a MUC reflects an occupant's `<delay>` to the room verbatim. Keep
 * the attribution REQUIRED rather than assumed — XEP-0203 makes `from` a SHOULD — so that a
 * co-occupant cannot choose the timestamp core shows the agent, which the server-built
 * `<forwarded>` envelope the catch-up path reads would then disagree with.
 */
export const roomStamp = (stanza: El, room: string): string | undefined => {
  const delay = stanza.getChild('delay', NS_DELAY);
  if (delay === undefined) return undefined;
  return delay.attrs.from === room ? delay.attrs.stamp : undefined;
};

/**
 * The archive position this ROOM stamped on a stanza: XEP-0359 `<stanza-id>`, whose id is the
 * XEP-0313 MAM id. Keep the `by` filter, so that a `<stanza-id>` an occupant put on its own message
 * — which the MUC reflects verbatim — is never read as a position in the archive.
 */
export const roomStanzaId = (stanza: El, room: string): string | undefined =>
  stanza.getChildren('stanza-id', NS_SID).find((e) => e.attrs.by === room)?.attrs.id;

export const advertisesFeature = (info: El, feature: string): boolean =>
  (info.getChild('query', NS_DISCO_INFO)?.getChildren('feature') ?? []).some(
    (f) => f.attrs.var === feature,
  );

/** Enter `room` as `nick`, asking for NO history (the archive is read through MAM instead). */
export const joinPresence = (room: string, nick: string): unknown =>
  xml(
    'presence',
    { to: `${room}/${nick}` },
    xml('x', { xmlns: NS_MUC }, xml('history', { maxstanzas: '0' })),
  );

export const groupchatMessage = (room: string, originId: string, content: string): unknown =>
  xml(
    'message',
    { to: room, type: 'groupchat', id: originId },
    xml('body', {}, content),
    xml('origin-id', { xmlns: NS_SID, id: originId }),
  );

export const discoInfoIq = (room: string): unknown =>
  xml('iq', { type: 'get', to: room }, xml('query', { xmlns: NS_DISCO_INFO }));

/** One MAM page of `room`, tagged `queryid` so its streamed `<result>` items can be gathered. */
export const mamQueryIq = (
  room: string,
  queryid: string,
  opts: { after?: string; lastPage?: boolean; max: number },
): unknown => {
  const rsm: unknown[] = [];
  // Keep the zero cursor '' omitting <after/> entirely, so that "from the beginning" never
  // depends on how a server answers an <after> UID it does not hold — RSM (XEP-0059) says
  // item-not-found, Prosody's mod_mam replays the whole archive.
  if (opts.after !== undefined && opts.after !== '') {
    assertXmlSafe(opts.after, 'catch-up cursor');
    rsm.push(xml('after', {}, opts.after));
  }
  rsm.push(xml('max', {}, String(opts.max)));
  if (opts.lastPage === true) rsm.push(xml('before', {}));
  return xml(
    'iq',
    { type: 'set', to: room },
    xml('query', { xmlns: NS_MAM, queryid }, xml('set', { xmlns: NS_RSM }, ...(rsm as never[]))),
  );
};

/**
 * XEP-0045 §10.1.2 config submit for a room this connection just created. A service that refuses the
 * persistent-room field rejects the whole form, and an unsubmitted form leaves the room locked, so
 * the bare submit (`persistent: false`) is the fallback rather than an alternative.
 */
export const roomConfigIq = (room: string, persistent: boolean): unknown => {
  const fields = persistent
    ? [
        xml('field', { var: 'FORM_TYPE', type: 'hidden' }, xml('value', {}, NS_ROOMCONFIG)),
        xml('field', { var: 'muc#roomconfig_persistentroom' }, xml('value', {}, '1')),
      ]
    : [];
  return xml(
    'iq',
    { type: 'set', to: room },
    xml(
      'query',
      { xmlns: NS_MUC_OWNER },
      xml('x', { xmlns: NS_XDATA, type: 'submit' }, ...(fields as never[])),
    ),
  );
};
