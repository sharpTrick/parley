/**
 * Injective topic → backend-name mapping (DESIGN §4 seam; BUG-14/SEC-07/CX-03).
 *
 * Backends map an opaque Parley {@link Topic} onto a backend-specific channel name (NATS
 * subject/stream, Matrix room alias, XMPP MUC JID) via a legal-charset fold. Those folds are
 * many-to-one, so distinct topics can collide onto one backend name and cross-deliver. This
 * helper wraps any such fold to make it injective.
 */

import { createHash } from 'node:crypto';
import type { Topic } from './message.js';

/**
 * Injective topic → backend-name mapping. `sanitize` is the backend's legal-charset fold
 * (unchanged from today). Whenever that fold is LOSSY for this topic — i.e. the sanitized
 * form differs from the raw topic string (character replacement, lowercasing, or truncation)
 * — we append `<sep><shorthash(raw)>` so two distinct topics can never share one backend name.
 * Hash is over the RAW topic's UTF-8 bytes, exactly like bridge-postgres channelFor.
 *
 * A naturally-safe topic passes through unchanged so existing rooms/streams keep their readable
 * names — EXCEPT when it already looks like a disambiguated name, which would otherwise let a
 * caller pick the raw topic `<sanitized><sep><hash>` and land in another topic's channel. Those
 * are disambiguated too, keeping the two branches' outputs disjoint.
 */
export function safeName(
  topic: Topic,
  sanitize: (s: string) => string,
  opts: { hashLen?: number; sep?: string } = {},
): string {
  const raw = topic as string;
  const hashLen = opts.hashLen ?? 10;
  const sep = opts.sep ?? '-';
  const sanitized = sanitize(raw);
  if (sanitized === raw && !isDisambiguated(raw, sep, hashLen)) return sanitized;
  const hash = createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, hashLen);
  return `${sanitized}${sep}${hash}`;
}

function isDisambiguated(name: string, sep: string, hashLen: number): boolean {
  if (name.length <= sep.length + hashLen) return false;
  if (!name.startsWith(sep, name.length - sep.length - hashLen)) return false;
  return /^[0-9a-f]+$/.test(name.slice(name.length - hashLen));
}
