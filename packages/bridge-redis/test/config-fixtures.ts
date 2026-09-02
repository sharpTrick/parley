// The knob × value matrix both failure-mode files drive: `failure-modes.test.ts` asserts every row is
// REJECTED (no server needed — validation runs before the connection), `live-failure-modes.test.ts`
// asserts a rejected row never tears a live connection down. Keep one copy, so that the two files
// cannot drift and leave a knob rejected in one and unguarded in the other.

/** Values no millisecond/day knob can mean, whatever it is wired to. */
const NEVER_A_KNOB: Array<[string, unknown]> = [
  ['zero', 0],
  ['negative', -1],
  ['NaN', Number.NaN],
  ['Infinity', Number.POSITIVE_INFINITY],
  ['-Infinity', Number.NEGATIVE_INFINITY],
  ['numeric string', '7'],
  ['boolean', true],
  ['object', {}],
  ['array', [7]],
];

/**
 * Values no string knob can mean. The empty string is the one that matters most: it is what an
 * unexpanded `"${REDIS_URL}"` or an empty secret yields, and node-redis reads a falsy url as
 * "unset" and connects to the unauthenticated default endpoint instead.
 */
const NEVER_A_STRING: Array<[string, unknown]> = [
  ['the empty string', ''],
  ['a number', 5],
  ['boolean', true],
  ['object', {}],
  ['array', ['a']],
];

/**
 * Non-empty strings that clear the emptiness check and then fail INSIDE node-redis' constructor as a
 * bare `TypeError: Invalid URL`/`Invalid protocol` naming neither the plugin, the key, nor anything
 * an operator with a typo'd scheme could grep for — and only AFTER a live connection was torn down.
 */
const NEVER_A_REDIS_URL: Array<[string, unknown]> = [
  ['prose', 'not a url'],
  ['a missing colon', 'redis//127.0.0.1'],
  ['a bare host:port', '127.0.0.1:6379'],
  ['the wrong scheme', 'http://127.0.0.1:6379'],
  ['a scheme node-redis does not speak', 'redis+unix:///tmp/redis.sock'],
  ['a scheme with no host', 'redis://'],
];

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
 * error into — the escape `fromCaller`/`sanitizeBody` exist to close.
 */
export const RENDER_LEAK_SENTINEL = 'rendering me leaks this line';

/**
 * Values that break the RENDERER rather than the validator: every one of these is refused on shape,
 * but only after `describeValue` has tried to put it in the message. A renderer that throws turns a
 * labelled refusal into a bare multi-line `TypeError` — or, for a `toJSON` that raises, into the
 * caller's OWN text, unsanitised, in the operator's log and in the model context core renders a
 * thrown seam error into. Crossed over every knob below, because the renderer is shared and a guard
 * added to one validator would not cover the others.
 */
const NEVER_RENDERABLE: Array<[string, unknown]> = [
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
];

const rejectedByShape: Record<string, Array<[string, unknown]>> = {
  url: [...NEVER_A_STRING, ...NEVER_A_REDIS_URL],
  key_prefix: NEVER_A_STRING,
  retention_days: [
    ...NEVER_A_KNOB,
    ['past the epoch', 1e9],
    ['negative fraction', -0.5],
  ],
  block_ms: [
    ...NEVER_A_KNOB,
    ['sub-millisecond fraction', 0.5],
    ['fraction over one', 1.5],
    ['negative fraction', -0.5],
    ['beyond safe integer', 2 ** 53],
  ],
  connect_timeout_ms: [
    ...NEVER_A_KNOB,
    ['sub-millisecond fraction', 0.5],
    ['fraction over one', 1.5],
    ['negative fraction', -0.5],
    ['beyond safe integer', 2 ** 53],
  ],
};

/**
 * Every knob crossed with every value it must refuse. Built by APPENDING the shared shapes rather
 * than listing them per knob, so a knob added later cannot get the value axis half-applied.
 */
export const rejectedByKnob: Record<string, Array<[string, unknown]>> = Object.fromEntries(
  Object.entries(rejectedByShape).map(([knob, values]) => [knob, [...values, ...NEVER_RENDERABLE]]),
);

export const rejectedRows = Object.entries(rejectedByKnob).flatMap(([knob, values]) =>
  values.map(([label, value]) => [knob, label, value] as [string, string, unknown]),
);

/** Render a config value for a failure line; `JSON.stringify` alone turns NaN into `null`. */
export function label(value: unknown): string {
  return typeof value === 'number' ? String(value) : JSON.stringify(value) ?? String(value);
}
