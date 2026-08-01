/**
 * The storage-hostile value corpus, and the arm each value is claimed to take. It lives here rather
 * than in one test file because the two arms can only be graded in two different places: a refusal
 * happens before any SQL and a fake can see it, while "stored and read back unchanged" is a
 * property only a real server can decide. A corpus row whose arm is graded by a fake alone asserts
 * nothing about the server — which is how a value the driver silently rewrote to U+FFFD shipped
 * green under a row claiming it was fine.
 */

export const REFUSED = 'refused by name, before any SQL';
export const ROUND_TRIPS = 'stored, and read back byte-identical';

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
  ['a megabyte of text', 'x'.repeat(1024 * 1024), ROUND_TRIPS],
  ['SQL punctuation', `'; DROP TABLE "parley_messages"; --`, ROUND_TRIPS],
  ['a backslash and a newline', 'a\\b\nc', ROUND_TRIPS],
  [
    'other C0 control characters',
    `a${String.fromCharCode(1)}b${String.fromCharCode(0x1f)}c`,
    ROUND_TRIPS,
  ],
  ['a combining sequence left decomposed', 'école'.normalize('NFD'), ROUND_TRIPS],
  ['leading and trailing whitespace', ' padded ', ROUND_TRIPS],
];

export const ROUND_TRIP_VALUES: string[] = CORPUS.filter(([, , arm]) => arm === ROUND_TRIPS).map(
  ([, value]) => value,
);

/**
 * PostgreSQL refuses a btree index row over 8191 bytes, and `topic`, `sender` and `in_reply_to` are
 * all index keys in this schema while `content` is not. Derive the split from the value's own
 * encoded length, so that a corpus row added later lands in the cells the server can actually hold
 * it in without anyone marking it up by hand.
 */
export const INDEX_KEY_MAX_BYTES = 8191;

export function indexableFields(value: string): Field[] {
  return Buffer.byteLength(value, 'utf8') <= INDEX_KEY_MAX_BYTES ? FIELDS : ['content'];
}
