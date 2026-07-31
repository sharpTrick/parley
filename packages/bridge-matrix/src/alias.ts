import { MIN_HASH_LEN, safeName, type Topic } from '@sharptrick/parley-core';
import { createHash } from 'node:crypto';

/**
 * Matrix alias localparts allow a restricted character set; map anything else to `_`. Exported so
 * that this package's tests — and its fake homeserver's alias directory — grade THIS fold rather
 * than a hand-copy of it: two topics folding onto one localpart share a room and cross-deliver.
 * Keep the output ASCII, so that {@link boundedLocalpart} may count its limit in characters.
 */
export const sanitizeAlias = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, '_');

/** Bytes Matrix allows in a room alias, `#` and `:<server_name>` included. */
const MAX_ALIAS_BYTES = 255;

const ALIAS_PREFIX = 'parley_';

/**
 * Bounded so `#<localpart>:<server_name>` stays inside {@link MAX_ALIAS_BYTES}. Past that the
 * homeserver refuses `createRoom` with a 400 naming neither the topic nor this plugin, while every
 * read of the topic returns the empty page a never-written one returns — so it silently never
 * works. An over-long name keeps a {@link MIN_HASH_LEN}-wide digest of the whole raw topic and
 * truncates only the readable half, so the fold stays injective.
 */
export function boundedLocalpart(topic: Topic, serverName: string): string {
  const budget = MAX_ALIAS_BYTES - Buffer.byteLength(`#:${serverName}`, 'utf8');
  const name = `${ALIAS_PREFIX}${safeName(topic, sanitizeAlias)}`;
  if (name.length <= budget) return name;
  const keep = budget - ALIAS_PREFIX.length - 1 - MIN_HASH_LEN;
  if (keep < 1) {
    throw new Error(
      `[parley-matrix] backend_config.server_name ${JSON.stringify(serverName)} leaves no room ` +
        `for a distinct alias localpart: #<localpart>:<server_name> must fit ${MAX_ALIAS_BYTES} ` +
        `bytes, and topic ${JSON.stringify(String(topic))} needs at least ` +
        `${ALIAS_PREFIX.length + 1 + MIN_HASH_LEN + 1} of them. Use a shorter server_name.`,
    );
  }
  const digest = createHash('sha1')
    .update(String(topic), 'utf8')
    .digest('hex')
    .slice(0, MIN_HASH_LEN);
  return `${ALIAS_PREFIX}${sanitizeAlias(String(topic)).slice(0, keep)}-${digest}`;
}
