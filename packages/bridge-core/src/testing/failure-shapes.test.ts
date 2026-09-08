import { describe, expect, it } from 'vitest';
import { FAILURE_SHAPE_NAMES, FAILURE_SHAPES } from './failure-shapes.js';

/**
 * CLASS: a shared fault table with no FLOOR. Every fire-and-forget site in this repo — and, through
 * the conformance suite, every backend's live path — is graded by driving this table, so an arm
 * deleted from it silently shrinks ten fault matrices at once and each of them stays green. A
 * `for (const shape of FAILURE_SHAPE_NAMES)` loop generates an EMPTY describe that passes.
 *
 * Pinned by the PROPERTY each arm exists for, PROBED rather than named: a count is satisfied by any
 * replacement, and a list of names is satisfied by renaming the arm that was deleted onto one that
 * survives. What a row here asserts is that some arm still THROWS SYNCHRONOUSLY, that some arm is
 * still a thenable that is not a native promise, that some arm still never settles — the questions
 * the sites under test actually differ on.
 */
type Arm = (real: Promise<unknown>) => unknown;

interface Probe {
  threw: boolean;
  returned: unknown;
  settled?: 'fulfilled' | 'rejected';
  reason?: unknown;
  settledInMicrotasks: boolean;
}

const MICROTASK_DRAIN = 10;
const MACROTASK_MS = 25;

async function probe(arm: Arm): Promise<Probe> {
  let returned: unknown;
  try {
    returned = arm(Promise.resolve());
  } catch {
    return { threw: true, returned: undefined, settledInMicrotasks: false };
  }
  const out: Probe = { threw: false, returned, settledInMicrotasks: false };
  void Promise.resolve(returned).then(
    () => {
      out.settled = 'fulfilled';
    },
    (reason: unknown) => {
      out.settled = 'rejected';
      out.reason = reason;
    },
  );
  for (let i = 0; i < MICROTASK_DRAIN; i++) await Promise.resolve();
  out.settledInMicrotasks = out.settled !== undefined;
  await new Promise((r) => setTimeout(r, MACROTASK_MS));
  return out;
}

const isThenable = (v: unknown): boolean =>
  typeof (v as { then?: unknown } | null | undefined)?.then === 'function';

const PROPERTIES: Array<[what: string, holds: (p: Probe) => boolean]> = [
  ['throws before it returns anything', (p) => p.threw],
  [
    'returns a native promise that rejects',
    (p) => !p.threw && p.returned instanceof Promise && p.settled === 'rejected',
  ],
  [
    'rejects with something that is not an Error',
    (p) => p.settled === 'rejected' && !(p.reason instanceof Error),
  ],
  [
    'rejects only after the microtask queue has drained',
    (p) => p.settled === 'rejected' && !p.settledInMicrotasks,
  ],
  [
    'returns a thenable that is not a native promise',
    (p) => !p.threw && isThenable(p.returned) && !(p.returned instanceof Promise),
  ],
  ['returns something that never settles at all', (p) => !p.threw && p.settled === undefined],
];

const probes = async (): Promise<Probe[]> =>
  Promise.all(FAILURE_SHAPE_NAMES.map((name) => probe(FAILURE_SHAPES[name])));

describe('the shared fault table keeps every property its consumers differ on', () => {
  /**
   * The RULER. A property row below reports "no arm does this" when the table lost the arm AND when
   * the probe stopped being able to see it, and only one of those is a defect in the table — so the
   * probe is graded against arms written here, whose classification is not in question.
   */
  it.each([
    ['a synchronous throw', (): unknown => { throw new Error('x'); }, [0]],
    ['an immediate rejection', (): unknown => Promise.reject(new Error('x')), [1]],
    ['a string rejection', (): unknown => Promise.reject('x'), [1, 2]],
    [
      'a deferred rejection',
      (): unknown =>
        new Promise((_r, reject) => {
          setTimeout(() => reject(new Error('x')), 0);
        }),
      [1, 3],
    ],
    [
      'a foreign thenable',
      (): unknown => ({ then: (_f: unknown, r: (e: unknown) => void) => r(new Error('x')) }),
      [4],
    ],
    ['a promise that never settles', (): unknown => new Promise(() => {}), [5]],
    ['a plain resolved value', (): unknown => undefined, []],
  ] as Array<[string, Arm, number[]]>)('reads %s as exactly the properties it has', async (
    _label,
    arm,
    expected,
  ) => {
    const p = await probe(arm);
    expect(PROPERTIES.flatMap(([, holds], i) => (holds(p) ? [i] : []))).toEqual(expected);
  });

  it.each(PROPERTIES.map(([what], i) => [what, i] as const))(
    'at least one shape %s',
    async (what, index) => {
      const found = (await probes()).filter((p) => (PROPERTIES[index] as [string, (p: Probe) => boolean])[1](p));
      expect(
        found.length,
        `no arm of FAILURE_SHAPES ${what} any more. Every fire-and-forget site in this repo and ` +
          `every backend's live path is graded by driving this table, so the arm that carried ` +
          'this property took the grade for it out of ten fault matrices at once',
      ).toBeGreaterThan(0);
    },
  );
});
