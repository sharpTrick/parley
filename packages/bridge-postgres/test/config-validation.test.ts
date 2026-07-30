import { asHandle, asTopic, type BackendConfig } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin, validateBackendConfig } from '../src/index.js';
import { assertTableName } from '../src/schema.js';
import { dropTable, isUp, PG_URL, rand } from './pg-harness.js';

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

/** Resolve to 'hung' rather than letting a never-settling connect() blow the suite timeout. */
async function settles(p: Promise<unknown>): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const outcome = await Promise.race([
    p.then(
      () => 'resolved',
      (e: unknown) => `rejected: ${e instanceof Error ? e.message : String(e)}`,
    ),
    new Promise<string>((r) => {
      timer = setTimeout(() => r('hung'), SETTLE_MS);
    }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  return outcome;
}

if (await isUp(PG_URL)) {
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
            const outcome = await settles(
              p.connect({ url: PG_URL, table_name: table, [key]: value } as unknown as BackendConfig),
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
