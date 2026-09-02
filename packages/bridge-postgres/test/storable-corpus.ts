/**
 * The storage-hostile value corpus, and the arm each value is claimed to take. It lives here rather
 * than in one test file because the two arms can only be graded in two different places: a refusal
 * happens before any SQL and a fake can see it, while "stored and read back unchanged" is a
 * property only a real server can decide. A corpus row whose arm is graded by a fake alone asserts
 * nothing about the server — which is how a value the driver silently rewrote to U+FFFD shipped
 * green under a row claiming it was fine.
 */

import { INDEXED_FIELDS, MAX_INDEXED_BYTES } from '../src/errors.js';

export const REFUSED = 'refused by name, before any SQL';
export const ROUND_TRIPS = 'stored, and read back byte-identical';
/**
 * The one arm whose verdict depends on WHICH field carries the value: too long for a btree key, so
 * refused for the fields this backend indexes and stored for the fields it does not. A row declared
 * flatly REFUSED here would demand that `content` reject a 4 KiB string, which the server holds
 * happily; a row declared flatly ROUND_TRIPS would drive it into `topic`, where the server answers
 * SQLSTATE 54000.
 */
export const TOO_LONG_TO_INDEX = 'refused for an indexed field, stored for the rest';

export type Field = 'content' | 'topic' | 'handle' | 'inReplyTo';

export const FIELDS: Field[] = ['content', 'topic', 'handle', 'inReplyTo'];

const NUL = String.fromCharCode(0);

/** A real surrogate pair, so the halves below are code units UTF-16 actually produces. */
const PAIR = String.fromCodePoint(0x1f600);
const HIGH = PAIR[0] as string;
const LOW = PAIR[1] as string;

/**
 * Every position an unpaired surrogate can occupy, generated from {@link PAIR} rather than typed
 * out: a high with no low after it, a low with no high before it, either at a string boundary, and
 * the two halves a `slice()` through an emoji leaves behind — the way an agent truncating a message
 * produces one without meaning to.
 */
const UNPAIRED: [label: string, value: string][] = [
  ['a lone high surrogate in the middle', `lone${HIGH}surrogate`],
  ['a lone low surrogate in the middle', `lone${LOW}surrogate`],
  ['a lone high surrogate at the end', `trailing${HIGH}`],
  ['a lone low surrogate at the start', `${LOW}leading`],
  ['nothing but a lone high surrogate', HIGH],
  ['nothing but a lone low surrogate', LOW],
  ['the leading half of a pair a slice() split', `emoji ${PAIR}`.slice(0, -1)],
  ['the trailing half of a pair a slice() split', `${PAIR} emoji`.slice(1)],
];

/**
 * Printable ASCII a compressor cannot shrink, from a fixed seed so every run measures the same
 * bytes. The generator matters as much as the length: PostgreSQL compresses an index key before it
 * measures it, so `'x'.repeat(n)` fits in a btree at any n and grades nothing about the ceiling.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()_+-=[]{};:,.<>?';

export function incompressible(bytes: number, seed = 12345): string {
  let state = seed >>> 0;
  let out = '';
  for (let i = 0; i < bytes; i++) {
    state = (state * 1664525 + 1013904223) >>> 0;
    out += ALPHABET[(state >>> 8) % ALPHABET.length] as string;
  }
  return out;
}

/**
 * Both sides of the btree ceiling, anchored to the plugin's own budget so a limit that moves moves
 * WHICH row fires instead of silencing the rule. Every one of these is generated, so the corpus can
 * straddle a boundary no hand-typed value would land on.
 */
const BOUNDARY: [label: string, value: string, arm: string][] = [
  ['a value comfortably inside the index-key budget', incompressible(2600, 1), ROUND_TRIPS],
  ['a value exactly at the index-key budget', incompressible(MAX_INDEXED_BYTES, 2), ROUND_TRIPS],
  [
    'a value one byte past the index-key budget',
    incompressible(MAX_INDEXED_BYTES + 1, 3),
    TOO_LONG_TO_INDEX,
  ],
  ['a value at four kibibytes', incompressible(4096, 4), TOO_LONG_TO_INDEX],
  ['a value at eight kibibytes', incompressible(8192, 5), TOO_LONG_TO_INDEX],
];

/**
 * One row per distinct STORAGE hazard, not one per string someone thought of. The NUL and unpaired
 * surrogate rows are the ones this backend cannot store as given; the rest merely LOOK hostile and
 * must keep working, so the rule cannot degenerate into "refuse anything unusual".
 */
export const CORPUS: [label: string, value: string, arm: string][] = [
  ['a NUL at the start', `${NUL}abc`, REFUSED],
  ['a NUL in the middle', `hello${NUL}world`, REFUSED],
  ['a NUL at the end', `abc${NUL}`, REFUSED],
  ['nothing but a NUL', NUL, REFUSED],
  ...UNPAIRED.map(([label, value]): [string, string, string] => [label, value, REFUSED]),
  ['an astral plane character', 'family 👨‍👩‍👧‍👦 emoji', ROUND_TRIPS],
  ['a megabyte of text', 'x'.repeat(1024 * 1024), TOO_LONG_TO_INDEX],
  ['SQL punctuation', `'; DROP TABLE "parley_messages"; --`, ROUND_TRIPS],
  ['a backslash and a newline', 'a\\b\nc', ROUND_TRIPS],
  [
    'other C0 control characters',
    `a${String.fromCharCode(1)}b${String.fromCharCode(0x1f)}c`,
    ROUND_TRIPS,
  ],
  ['a combining sequence left decomposed', 'école'.normalize('NFD'), ROUND_TRIPS],
  ['leading and trailing whitespace', ' padded ', ROUND_TRIPS],
  ...BOUNDARY,
];

/** Which arm this value takes in this field — see {@link TOO_LONG_TO_INDEX}. */
export function armFor(arm: string, field: Field): string {
  if (arm !== TOO_LONG_TO_INDEX) return arm;
  return INDEXED_FIELDS.has(field) ? REFUSED : ROUND_TRIPS;
}

/**
 * The fields a real server will hold this value in, derived from the value's own encoded length and
 * from the plugin's own budget rather than from a number restated here. A constant copied into this
 * file is a server fact nobody re-measures: the one that used to sit here claimed 8191 bytes and
 * claimed `sender` and `in_reply_to` were index keys, and both were false for four rounds because
 * no corpus row landed in the window where it mattered. The real ceiling is measured against a live
 * server elsewhere in this suite; nothing here restates it.
 */
export function fieldsThatHold(value: string): Field[] {
  const oversized = Buffer.byteLength(value, 'utf8') > MAX_INDEXED_BYTES;
  return FIELDS.filter((field) => !(oversized && INDEXED_FIELDS.has(field)));
}

export const ROUND_TRIP_VALUES: string[] = CORPUS.filter(
  ([, , arm]) => arm === ROUND_TRIPS || arm === TOO_LONG_TO_INDEX,
).map(([, value]) => value);
