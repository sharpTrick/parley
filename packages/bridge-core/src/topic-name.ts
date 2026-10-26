/**
 * Injective topic → backend-name mapping (DESIGN §4 seam).
 *
 * Backends map an opaque Parley {@link Topic} onto a backend-specific channel name (NATS
 * subject/stream, Matrix room alias, XMPP MUC JID) via a legal-charset fold. Those folds are
 * many-to-one, so distinct topics can collide onto one backend name and cross-deliver. This
 * helper wraps any such fold to make it injective.
 */

import { createHash } from 'node:crypto';
import type { Topic } from './message.js';

/**
 * Shortest disambiguating suffix {@link safeName} will mint. A caller may ask for this narrow a
 * suffix deliberately; nothing mints it by default.
 */
export const MIN_HASH_LEN = 10;

/**
 * Width {@link safeName} mints when `hashLen` is omitted — which is every shipped backend, so this
 * is the number a deployment actually runs on. It is a security parameter, not a formatting choice.
 *
 * Injectivity is PROBABILISTIC: the suffix is a truncated digest, so landing on a chosen target
 * name costs about `2^(4 × hashLen)` hashes. What bounds the search in practice is the FOLD rather
 * than the digest — an attacker needs a raw topic with the same sanitized form as the victim's, so
 * a fold replacing illegal characters one-for-one offers only `|illegal alphabet|^(lossy positions)`
 * candidates. That is why 40 bits was not enough: over the Matrix alias fold, which rejects
 * everything outside `[A-Za-z0-9._-]`, three lossy positions in a victim topic already put a
 * collision in reach, and a collision routes one topic's traffic into another's backend channel.
 *
 * Changing this RENAMES every room, stream and MUC an existing deployment created, because the
 * suffix is part of the backend name — messages in the old channels stop being addressable through
 * Parley. Keep it fixed unless a rename is the deliberate intent.
 */
export const DEFAULT_HASH_LEN = 16;

/** Widest suffix there are digest bytes for; a caller asking for more is refused, not padded. */
export const MAX_HASH_LEN = createHash('sha1').update('').digest('hex').length;

/**
 * Injective topic → backend-name mapping. `sanitize` is the backend's legal-charset fold. Whenever
 * that fold is LOSSY for this topic — i.e. the sanitized form differs from the raw topic string
 * (character replacement, lowercasing, or truncation) — we append `<sep><shorthash(raw)>` so two
 * distinct topics can never share one backend name.
 * Hash is over the RAW topic's UTF-8 bytes.
 *
 * A naturally-safe topic passes through unchanged so existing rooms/streams keep their readable
 * names — EXCEPT when it already looks like a disambiguated name, which would otherwise let a
 * caller pick the raw topic `<sanitized><sep><hash>` and land in another topic's channel. Those
 * are disambiguated too, keeping the two branches' outputs disjoint.
 *
 * Throws when `hashLen` is outside {@link MIN_HASH_LEN}…{@link MAX_HASH_LEN}, when the name it would
 * return is EMPTY — a name identifying no channel addresses the backend as a whole, and every topic
 * a fold empties would share it — and when the name it built is not a fixed point of `sanitize`: a
 * truncating fold, or one whose charset excludes `sep` or lowercase hex, would otherwise get back a
 * name it rewrites, which is exactly the collision this helper exists to prevent.
 */
export function safeName(
  topic: Topic,
  sanitize: (s: string) => string,
  opts: { hashLen?: number; sep?: string } = {},
): string {
  const raw = topic as string;
  const hashLen = opts.hashLen ?? DEFAULT_HASH_LEN;
  const sep = opts.sep ?? '-';
  if (!Number.isInteger(hashLen) || hashLen < MIN_HASH_LEN || hashLen > MAX_HASH_LEN)
    throw new RangeError(
      `safeName hashLen must be an integer in [${MIN_HASH_LEN}, ${MAX_HASH_LEN}]; got ${hashLen}. ` +
        'A shorter suffix is brute-forceable, and two topics sharing one backend name cross-deliver.',
    );
  const sanitized = sanitize(raw);
  if (sanitized === raw && !isDisambiguated(raw, sep, hashLen)) return assertNames(sanitized, raw);
  const hash = createHash('sha1').update(raw, 'utf8').digest('hex').slice(0, hashLen);
  const name = `${sanitized}${sep}${hash}`;
  const refolded = sanitize(name);
  if (refolded !== name)
    throw new Error(
      `safeName built ${JSON.stringify(name)} for topic ${JSON.stringify(raw)}, but this backend's ` +
        `fold rewrites it to ${JSON.stringify(refolded)}: the disambiguating suffix does not ` +
        'survive the backend name rules (a length limit, or a charset excluding ' +
        `${JSON.stringify(sep)} or lowercase hex). Topics would collide on this backend.`,
    );
  return assertNames(name, raw);
}

function assertNames(name: string, raw: string): string {
  if (name !== '') return name;
  throw new Error(
    `safeName produced an EMPTY backend name for topic ${JSON.stringify(raw)}: a name that ` +
      'identifies no channel addresses the backend as a whole, and every topic this fold empties ' +
      'would share it. Reject the topic before it reaches the backend.',
  );
}

function isDisambiguated(name: string, sep: string, hashLen: number): boolean {
  if (name.length < sep.length + hashLen) return false;
  if (!name.startsWith(sep, name.length - sep.length - hashLen)) return false;
  return /^[0-9a-f]+$/.test(name.slice(name.length - hashLen));
}
