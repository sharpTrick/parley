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

export const NEVER_RENDERABLE: Array<[string, unknown]> = [
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
