import { asTopic, type Handle, safeName, type Topic } from '@sharptrick/parley-core';

/** RFC 7622 §3.3/§3.4: a localpart or resourcepart longer than this is `jid-malformed`. */
export const JID_PART_MAX_BYTES = 1023;

export const resourceOf = (full: string): string => {
  const i = full.indexOf('/');
  return i === -1 ? '' : full.slice(i + 1);
};
export const bareOf = (full: string): string => {
  const i = full.indexOf('/');
  return i === -1 ? full : full.slice(0, i);
};
/**
 * Who a stanza's `from` says said it: the occupant nick, or — for a room-level stanza, which has no
 * resource — the room itself. Keep the room out of `fallback`, so that a service announcement is
 * never attributed to this bridge's own handle and read back as something it said.
 */
export const senderOf = (from: string, fallback: string): string => {
  const nick = resourceOf(from);
  if (nick !== '') return nick;
  const bare = bareOf(from);
  return bare !== '' ? bare : fallback;
};

// JID localparts are case-insensitive and may not contain "&'/:<>@ or whitespace; fold to a
// safe, lowercase token. freshTopic() values (t-<n>-<rand>) pass through unchanged. Keep it free of
// a length limit, as {@link sanitizeNick} is: the ceiling is enforced on the fold's RESULT, because
// a fold that truncates makes safeName refuse the name it just built instead of returning it.
const sanitizeLocal = (s: string): string => s.toLowerCase().replace(/[^a-z0-9.\-_]/g, '_');

/** The MUC room localpart a topic maps to: `<localpart>@<muc_service>` is the room JID. */
export const roomLocalpart = (topic: Topic): string => {
  const local = safeName(topic, sanitizeLocal);
  if (local.length > JID_PART_MAX_BYTES) {
    throw new Error(
      `parley-xmpp: topic is ${String(topic).length} characters, whose MUC room localpart would ` +
        `be ${local.length} bytes — over the ${JID_PART_MAX_BYTES}-byte JID limit, which the ` +
        'server answers with jid-malformed. Use a shorter topic.',
    );
  }
  return local;
};

// A MUC nick is a JID resource: no control characters, and nothing that would split the JID. The
// fold is injective via safeName, so two handles can never land on one occupant identity. Keep it
// free of a length limit, so that safeName's disambiguating suffix survives a re-fold — a truncating
// fold makes safeName refuse the handle outright, and with it every post made under that identity.
const sanitizeNick = (s: string): string => s.replace(/[^A-Za-z0-9.\-_]/g, '_');

export const nickFor = (identity: Handle): string => {
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
