/**
 * Values that break the RENDERER rather than the validator. Every backend refuses these on shape,
 * but only AFTER `describeConfigValue` has tried to put one in the refusal message — so a renderer
 * that throws turns a labelled refusal into a bare multi-line `TypeError`, and one that raises from
 * a caller's own `toJSON` puts the CALLER's text, unsanitised, into the operator's log and into the
 * model context core renders a thrown seam error into.
 *
 * Shared because the renderer is: a guard added for one plugin's validator would not cover the
 * others, and five of them re-implemented this rendering until it was lifted here.
 */
const circular = (): unknown[] => {
  const a: unknown[] = [];
  a.push(a);
  return a;
};

const selfReferential = (): Record<string, unknown> => {
  const o: Record<string, unknown> = {};
  o.self = o;
  return o;
};

/** No JSON form (`toJSON` yields nothing) and no string form (no prototype to take `toString` from). */
const textless = (): unknown =>
  Object.assign(Object.create(null) as object, { toJSON: () => undefined });

/**
 * What a raising `toJSON` puts in its own message. A refusal that carries this carries a line the
 * CALLER wrote, straight into the operator's log and the model context core renders a thrown seam
 * error into — the escape `sanitizeBody` exists to close.
 */
export const RENDER_LEAK_SENTINEL = 'rendering me leaks this line';

export const NEVER_RENDERABLE: readonly (readonly [string, unknown])[] = [
  ['a circular array', circular()],
  ['a circular object', selfReferential()],
  [
    'a value whose toJSON throws',
    {
      toJSON(): never {
        throw new Error(RENDER_LEAK_SENTINEL);
      },
    },
  ],
  ['a value with neither a JSON form nor a string form', textless()],
  ['a bigint', 10n],
  ['a null-prototype object', Object.create(null) as unknown],
];

/**
 * Text a caller can put in a `backend_config` value that no refusal may pass through verbatim. It
 * reaches the operator's log and the model context core renders a seam error into, so it may not
 * forge line structure, carry a bidi override, or run unbounded.
 *
 * Every entry survives `JSON.stringify` INTACT. A newline, a carriage return and a C0 control are
 * all ESCAPED by it and arrive harmless, so a row carrying one would grade nothing; what it does not
 * escape is the two Unicode line breaks, every format character, and length. That is also what makes
 * these rows live where a hostile OBJECT is not — a container is described by shape and never
 * rendered, so only a PRIMITIVE reaches the sanitiser at all.
 */
export const UNSAFE_TEXT: readonly (readonly [string, string])[] = [
  ['a LINE SEPARATOR (U+2028)', 'before\u2028after'],
  ['a PARAGRAPH SEPARATOR (U+2029)', 'before\u2029after'],
  ['a RIGHT-TO-LEFT OVERRIDE (U+202E)', 'before\u202Eafter'],
  ['4KiB of one character', 'x'.repeat(4096)],
  ['4KiB carrying a bidi override', `${'x'.repeat(4096)}\u202Eafter`],
];

/** Every code point a rendered value may not carry: Unicode control, format, and the two separators. */
export const FORBIDDEN_IN_RENDER = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

/** A secret nobody could reach any other way, so finding it in a message means the message leaked it. */
export const PLANTED_SECRET = 'PLANTED-SECRET-8f3a';

/**
 * Containers holding {@link PLANTED_SECRET}. The branch that hands a rejected value to a renderer
 * reads "not a non-empty string", which admits every one of these — so a renderer that ENUMERATES
 * one puts the secret in the operator's log and in the model context core renders a seam error into,
 * whatever key it was written under.
 */
export const WRAPPING_A_SECRET: readonly (readonly [string, unknown])[] = [
  ['an object', { password: PLANTED_SECRET }],
  ['an array', [PLANTED_SECRET]],
  ['a nested object', { outer: { inner: [PLANTED_SECRET] } }],
  ['a null-prototype object', Object.assign(Object.create(null) as object, { v: PLANTED_SECRET })],
  ['a value whose toString yields it', { toString: () => PLANTED_SECRET }],
  ['a boxed String', new String(PLANTED_SECRET)],
  ['a value with a Symbol.toPrimitive', { [Symbol.toPrimitive]: () => PLANTED_SECRET }],
  ['a symbol whose description is it', Symbol(PLANTED_SECRET)],
  ['a function whose source names it', (): string => PLANTED_SECRET],
];

/**
 * A value whose own TEXT is {@link PLANTED_SECRET} while its type is not `string`. Every backend
 * refuses it — each of these keys reads `expected a non-empty string` — and a renderer spelled
 * `typeof raw === 'string' ? JSON.stringify(raw) : String(raw)` prints it in full, which is the
 * shape three plugins shipped past a ratchet that only asked the five it had already fixed.
 */
export const boxedSecret = (): unknown => new String(PLANTED_SECRET);
