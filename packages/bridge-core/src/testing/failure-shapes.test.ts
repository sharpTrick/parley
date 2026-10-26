import { describe, expect, it } from 'vitest';
import { FAILURE_SHAPE_NAMES, FAILURE_SHAPES, unhandledDuring } from './failure-shapes.js';

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
  thrown?: unknown;
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
  } catch (err) {
    return { threw: true, thrown: err, returned: undefined, settledInMicrotasks: false };
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
  ['throws something that is not an Error', (p) => p.threw && !(p.thrown instanceof Error)],
  ['throws an Error', (p) => p.threw && p.thrown instanceof Error],
  [
    'rejects with an Error',
    (p) => p.settled === 'rejected' && p.reason instanceof Error,
  ],
  [
    'rejects before the microtask queue has drained',
    (p) => p.settled === 'rejected' && p.settledInMicrotasks,
  ],
  [
    // The ORDINARY case, named as a property of its own because every exotic arm here is a
    // variation on it: a site that absorbs the variations and drops the plain one has a hole no
    // other row can see, and without this the baseline arm is the one arm free to be deleted.
    'rejects the ordinary way — a native promise, an Error, inside the microtask queue',
    (p) =>
      !p.threw &&
      p.returned instanceof Promise &&
      p.settled === 'rejected' &&
      p.reason instanceof Error &&
      p.settledInMicrotasks,
  ],
];

/** Which properties an arm holds, as indices into {@link PROPERTIES}. */
const vectorOf = (p: Probe): number[] =>
  PROPERTIES.flatMap(([, holds], i) => (holds(p) ? [i] : []));

/**
 * The arms that could be DELETED with every row below still green: an arm holding no property that
 * some OTHER arm does not also hold. The per-property floor cannot see one — it asks whether SOME
 * arm still has each property, which the survivors answer. Every consumer is an
 * `it.each(FAILURE_SHAPE_NAMES)`, so the whole suite shrinks with the table and a deleted arm costs
 * no row anywhere.
 */
const deletable = (vectors: ReadonlyArray<readonly [string, readonly number[]]>): string[] =>
  vectors
    .filter(([name, held]) =>
      held.every((i) => vectors.some(([other, w]) => other !== name && w.includes(i))),
    )
    .map(([name]) => name);

const probes = async (): Promise<Probe[]> =>
  Promise.all(FAILURE_SHAPE_NAMES.map((name) => probe(FAILURE_SHAPES[name])));

describe('the shared fault table keeps every property its consumers differ on', () => {
  it('no arm can be deleted behind another', async () => {
    const held = (await probes()).map(
      (p, i) => [FAILURE_SHAPE_NAMES[i] as string, vectorOf(p)] as const,
    );
    expect(
      deletable(held),
      'this arm holds no property another arm does not also hold, so deleting it shrinks ten ' +
        'fault matrices at once with every row of this file still green',
    ).toEqual([]);
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

/**
 * CLASS: an escape detector that watches ONE of the two ways a failure leaves a fire-and-forget
 * site. A rejection nothing attached to arrives as `unhandledRejection`; a SYNCHRONOUS throw out of
 * a detached task arrives as `uncaughtException` — a different event, and a listener registered for
 * the first reports the second as clean. The run still exits non-zero, but no row reddens, so
 * anything reading the report sees green. The conformance clause that grades all ten backends' live
 * paths listened for rejections alone until this landed.
 *
 * The rejection-only control is what makes the row below unsatisfiable by half a detector.
 */
const rejectionsOnly = async (work: () => Promise<void>): Promise<unknown[]> => {
  const seen: unknown[] = [];
  const capture = (reason: unknown): void => {
    seen.push(reason);
  };
  const swallow = (): void => {};
  process.on('unhandledRejection', capture);
  process.on('uncaughtException', swallow);
  try {
    await work();
    await new Promise((r) => setTimeout(r, 40));
  } finally {
    process.off('unhandledRejection', capture);
    process.off('uncaughtException', swallow);
  }
  return seen;
};

const detachedThrow = async (): Promise<void> => {
  setTimeout(() => {
    throw new Error('escaped synchronously');
  }, 0);
};

const detachedRejection = async (): Promise<void> => {
  void Promise.reject(new Error('escaped as a rejection'));
};

describe('the escape detector sees both ways a fire-and-forget failure leaves', () => {
  it('sees a rejection nothing attached to', async () => {
    const escaped = await unhandledDuring(detachedRejection);
    expect(escaped.map(String).join(' ')).toContain('escaped as a rejection');
  });

  it('sees a synchronous throw out of a detached task', async () => {
    const escaped = await unhandledDuring(detachedThrow);
    expect(
      escaped.map(String).join(' '),
      'a synchronous throw that leaves a detached task reached nothing here. It arrives as ' +
        'uncaughtException, not as a rejection, so a detector registered for rejections alone ' +
        'reports the run clean while it exits non-zero with no row red',
    ).toContain('escaped synchronously');
  });

  it('is not satisfiable by a rejection-only listener, which is the half that was missing', async () => {
    expect((await rejectionsOnly(detachedRejection)).map(String).join(' ')).toContain(
      'escaped as a rejection',
    );
    expect(await rejectionsOnly(detachedThrow)).toEqual([]);
  });
});
