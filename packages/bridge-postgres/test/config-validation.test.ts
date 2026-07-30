import { asHandle, asTopic, type BackendConfig } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { MAX_RETENTION_DAYS, PostgresPlugin, validateBackendConfig } from '../src/index.js';
import { assertTableName } from '../src/schema.js';
import { dropTable, isUp, PG_URL, rand, settleWithin } from './pg-harness.js';

/**
 * `backend_config` is untyped YAML from an operator. Every knob is validated before the pool is
 * opened, so a bad value fails fast with a message naming the key — and, above all, can never take
 * an irreversible action (`retention_days: 0` used to mean "delete the entire history") and can
 * never hang (`pool_size: -3` used to mean "connect() never settles").
 */

/** Every knob is asserted to settle within this, so a hang fails as a hang and not as a timeout. */
const SETTLE_MS = 5000;

const BAD_VALUES: unknown[] = [
  0,
  -1,
  0.5,
  Number.NaN,
  Number.POSITIVE_INFINITY,
  Number.NEGATIVE_INFINITY,
  '',
  'abc',
  '30',
  null,
  true,
  [],
  {},
];

/** Values each key must accept, so the rejection table cannot degenerate into "reject everything". */
const GOOD_VALUES: Record<string, unknown[]> = {
  url: [PG_URL],
  table_name: ['parley_ok'],
  pool_size: [1, 2, 5],
  retention_days: [0.5, 1, 3650],
};

/** Bad values that are legitimate for a given key and therefore exempt from the rejection table. */
const EXEMPT: Record<string, unknown[]> = {
  url: ['abc', '30'],
  table_name: ['abc', '30'],
  pool_size: [],
  retention_days: [0.5],
};

/**
 * The two message shapes an operator's config can be refused with — one for a value, one for a key.
 * They are what an operator greps for, so a third shape invented later has to fail here rather than
 * quietly widening the contract.
 */
const REJECTION_SHAPES: [what: string, pattern: RegExp][] = [
  [
    'a refused value',
    /^parley-postgres: invalid backend_config\.(url|table_name|pool_size|retention_days) — \S/,
  ],
  ['an unknown key', /^parley-postgres: unknown backend_config key '.+' — expected one of \S/],
];

const BAD_TABLE_NAMES = ['', '1abc', 'a-b', 'a b', 'drop;', 'x'.repeat(64), 'ünïcode'];

describe('backend_config validation rejects every unusable value', () => {
  for (const key of Object.keys(GOOD_VALUES)) {
    for (const value of BAD_VALUES) {
      if (EXEMPT[key]?.includes(value)) continue;
      it(`${key} = ${JSON.stringify(value) ?? String(value)}`, () => {
        expect(() =>
          validateBackendConfig({ url: PG_URL, [key]: value } as unknown as BackendConfig),
        ).toThrow(new RegExp(`^parley-postgres: invalid backend_config\\.${key} — \\S`));
      });
    }

    for (const value of GOOD_VALUES[key] ?? []) {
      it(`${key} = ${JSON.stringify(value)} is accepted`, () => {
        expect(() =>
          validateBackendConfig({ url: PG_URL, [key]: value } as unknown as BackendConfig),
        ).not.toThrow();
      });
    }
  }

  it.each([['retention_day'], ['tablename'], ['db_path'], ['poll_interval_ms'], ['poolsize']])(
    'a mistyped key (%s) is rejected rather than silently ignored',
    (key) => {
      expect(() =>
        validateBackendConfig({ url: PG_URL, [key]: 30 } as unknown as BackendConfig),
      ).toThrow(new RegExp(`^parley-postgres: unknown backend_config key '${key}' — expected one of `));
    },
  );

  it('every rejection takes one of the two shapes, and both of them are reached', () => {
    const raised: string[] = [];
    const attempt = (fn: () => unknown): void => {
      try {
        fn();
      } catch (err) {
        raised.push(err instanceof Error ? err.message : String(err));
      }
    };

    for (const key of Object.keys(GOOD_VALUES)) {
      for (const value of BAD_VALUES) {
        if (EXEMPT[key]?.includes(value)) continue;
        attempt(() =>
          validateBackendConfig({ url: PG_URL, [key]: value } as unknown as BackendConfig),
        );
      }
    }
    for (const key of ['retention_day', 'poolsize']) {
      attempt(() => validateBackendConfig({ url: PG_URL, [key]: 30 } as unknown as BackendConfig));
    }
    for (const name of BAD_TABLE_NAMES) attempt(() => assertTableName(name));

    expect(
      raised.filter((m) => !REJECTION_SHAPES.some(([, p]) => p.test(m))),
      'a rejection invented a third message shape',
    ).toEqual([]);
    // A floor as well as a ceiling: an enumeration nothing exercises is satisfied by a validator
    // that raises nothing at all.
    for (const [what, pattern] of REJECTION_SHAPES) {
      expect(
        raised.filter((m) => pattern.test(m)).length,
        `nothing was refused as ${what}`,
      ).toBeGreaterThan(0);
    }
    expect(raised.length, 'far fewer rejections than cells attempted').toBeGreaterThan(
      BAD_TABLE_NAMES.length + 2,
    );
  });
});

// A knob validated only for sign is still accepted at magnitudes where it does nothing, or the
// opposite of what its own rejection message claims to prevent: `retention_days: 1e-9` deletes the
// entire history, and a large enough value makes the cutoff an un-renderable Date, which prune's
// deliberately-broad catch swallows — so pruning silently never runs while the README says rows are
// deleted hourly. So every numeric knob is walked over BOTH ends of its range, and each value has
// to be refused by name or produce an effect an operator could have predicted. Never accepted and
// inert.

interface NumericKnob {
  key: 'pool_size' | 'retention_days';
  floor: number;
  ceiling: number;
}

const NUMERIC_KNOBS: NumericKnob[] = [
  { key: 'pool_size', floor: 1, ceiling: 1000 },
  { key: 'retention_days', floor: 0, ceiling: MAX_RETENTION_DAYS },
];

function boundaryValues({ floor, ceiling }: NumericKnob): [label: string, value: number][] {
  return [
    ['far below the floor', floor - 1000],
    ['just below the floor', floor - 1],
    ['the floor', floor],
    ['just above the floor', floor + 1],
    ['nominal', Math.min(ceiling, Math.max(floor + 1, 5))],
    ['just below the ceiling', ceiling - 1],
    ['the ceiling', ceiling],
    ['just above the ceiling', ceiling + 1],
    ['ten ceilings', ceiling * 10],
    ['Number.MAX_VALUE', Number.MAX_VALUE],
    ['a nanoscale value', 1e-9],
    ['the smallest denormal', Number.MIN_VALUE],
  ];
}

const REFUSED = 'refused by name';
const PREDICTABLE = 'accepted, and its effect is one an operator could predict';

/** What the plugin would actually DO with a value it accepted, in the operator's terms. */
function acceptedEffect(key: NumericKnob['key'], value: number): string {
  if (key === 'pool_size') {
    return Number.isInteger(value) && value >= 1 && value <= 1000
      ? PREDICTABLE
      : `accepted outside the documented 1..1000 range: ${value}`;
  }
  const cutoff = new Date(Date.now() - value * 86_400_000);
  if (!Number.isFinite(cutoff.getTime())) {
    return (
      `accepted, but the cutoff for ${value} days is not a date prune can render — it throws ` +
      'into the best-effort catch and pruning silently never runs'
    );
  }
  // A cutoff older than the Unix epoch cannot fall on a message this backend wrote, so the knob
  // is a permanent no-op wearing the name of a feature the README says runs hourly.
  if (cutoff.getTime() < 0) {
    return (
      `accepted, but the cutoff for ${value} days is ${cutoff.toISOString()} — no stored row can ` +
      'ever be older than that, so pruning never removes anything'
    );
  }
  return PREDICTABLE;
}

function verdict(key: NumericKnob['key'], value: number): string {
  try {
    validateBackendConfig({ url: PG_URL, [key]: value } as unknown as BackendConfig);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return new RegExp(`^parley-postgres: invalid backend_config\\.${key} — \\S`).test(message)
      ? REFUSED
      : `refused with a message that does not name ${key}: ${message}`;
  }
  return acceptedEffect(key, value);
}

describe('a numeric knob is never accepted at a magnitude where it silently does nothing', () => {
  for (const knob of NUMERIC_KNOBS) {
    it.each(boundaryValues(knob))(`${knob.key} %s (%s)`, (_label, value) => {
      expect([REFUSED, PREDICTABLE]).toContain(verdict(knob.key, value));
    });
  }
});

if (await isUp(PG_URL)) {
  // The arithmetic above says what the plugin would do; this says what it does. Both ends of the
  // accepted retention range are driven against a real table, so "predictable" is graded as rows
  // that are actually there or actually gone rather than as a cutoff that merely renders.
  describe('an accepted retention_days does to a real table exactly what it says', () => {
    it.each([
      ['the widest accepted window keeps everything', MAX_RETENTION_DAYS, 3],
      ['a nanoscale window keeps nothing', 1e-9, 0],
    ])('%s', async (_label, retentionDays, survivors) => {
      const table = `parley_bnd_${rand()}`;
      const topic = asTopic(`bnd-${rand()}`);
      const seeder = new PostgresPlugin();
      await seeder.connect({ url: PG_URL, table_name: table });
      try {
        for (let i = 0; i < 3; i++) await seeder.post(topic, asHandle('u'), `m${i}`);
      } finally {
        await seeder.disconnect();
      }

      const plugin = new PostgresPlugin();
      await plugin.connect({ url: PG_URL, table_name: table, retention_days: retentionDays });
      try {
        await new Promise((r) => setTimeout(r, 500));
        const { messages } = await plugin.fetchRecent({ topic });
        expect(messages.length, 'retention did something other than what it promised').toBe(
          survivors,
        );
      } finally {
        await plugin.disconnect();
        await dropTable(table);
      }
    }, 30000);
  });

  describe('connect() with a bad backend_config settles fast and destroys nothing', () => {
    it('every bad value on every knob rejects within a bounded time, and the history survives', async () => {
      const table = `parley_cfg_${rand()}`;
      const topic = asTopic(`cfg-${rand()}`);
      const seeder = new PostgresPlugin();
      await seeder.connect({ url: PG_URL, table_name: table });
      try {
        for (let i = 0; i < 3; i++) await seeder.post(topic, asHandle('u'), `m${i}`);
      } finally {
        await seeder.disconnect();
      }

      try {
        // Collect every cell before asserting, so that one mutation reports all the knobs it broke
        // and the history check below still runs.
        const offenders: string[] = [];
        for (const key of ['pool_size', 'retention_days', 'table_name']) {
          for (const value of BAD_VALUES) {
            if (EXEMPT[key]?.includes(value)) continue;
            const p = new PostgresPlugin();
            const outcome = await settleWithin(
              p.connect({ url: PG_URL, table_name: table, [key]: value } as unknown as BackendConfig),
              SETTLE_MS,
            );
            await p.disconnect();
            if (!new RegExp(`^rejected: parley-postgres:.*${key}`).test(outcome)) {
              offenders.push(`${key} = ${String(value)} -> ${outcome}`);
            }
          }
        }
        expect(offenders, 'accepted or hung on a value it must reject').toEqual([]);

        const reader = new PostgresPlugin();
        await reader.connect({ url: PG_URL, table_name: table });
        try {
          const { messages } = await reader.fetchRecent({ topic });
          expect(messages.map((m) => m.content)).toEqual(['m0', 'm1', 'm2']);
        } finally {
          await reader.disconnect();
        }
      } finally {
        await dropTable(table);
      }
    }, 60000);
  });
} else {
  describe.skip(`connect() config validation (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
