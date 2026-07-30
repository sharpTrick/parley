import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asHandle, asTopic, type BackendConfig } from '@sharptrick/parley-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MAX_POLL_INTERVAL_MS, MIN_POLL_INTERVAL_MS, SqlitePlugin } from '../src/index.js';

/**
 * `backend_config` is untyped YAML from an operator. Every knob is validated before the database
 * is opened, so a bad value fails fast with a message naming the key — and, above all, can never
 * take an irreversible action (`retention_days: 0` used to mean "delete the entire history").
 * An *accepted* value carries the matching obligation: it has to be operable, not merely
 * non-throwing at connect.
 */

const T = asTopic('ctx');
const me = asHandle('alice');

const dirs: string[] = [];
function tmpDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'parley-cfg-'));
  dirs.push(d);
  return d;
}
const dbFile = () => join(tmpDir(), 'p.db');

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
let rootBefore: string[] = [];
beforeAll(() => {
  rootBefore = readdirSync(repoRoot).sort();
});

let open: SqlitePlugin[] = [];
afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
});

// Databases are gitignored, so a test that writes one to the repo root leaves residue no status
// check reports — and every worker, run and checkout then contends on the same file.
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
  const rootAfter = readdirSync(repoRoot).sort();
  expect(rootAfter).toEqual(rootBefore);
  expect(rootAfter.filter((f) => /\.db(-wal|-shm)?$/.test(f))).toEqual([]);
});

const BAD_VALUES: unknown[] = [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY, '', 'abc', null, [], {}, 1e308];

/** Values each key must accept, so the rejection table cannot degenerate into "reject everything". */
const GOOD_VALUES: Record<string, unknown[]> = {
  db_path: ['x.db'],
  poll_interval_ms: [10, 1000],
  retention_days: [0.5, 1, 3650],
};

/** Bad values that are legitimate for a given key and therefore exempt from the rejection table. */
const EXEMPT: Record<string, unknown[]> = {
  db_path: ['abc'],
  poll_interval_ms: [],
  retention_days: [0.5],
};

/**
 * A relative `db_path` resolves against the cwd, and the runner's cwd is the repo root — run those
 * cases in a scratch directory instead.
 */
async function inScratchCwd<R>(fn: () => Promise<R>): Promise<R> {
  const previous = process.cwd();
  process.chdir(tmpDir());
  try {
    return await fn();
  } finally {
    process.chdir(previous);
  }
}

describe('connect() rejects every bad backend_config value', () => {
  for (const key of Object.keys(GOOD_VALUES)) {
    for (const value of BAD_VALUES) {
      if (EXEMPT[key]?.includes(value)) continue;
      it(`${key} = ${JSON.stringify(value) ?? String(value)}`, async () => {
        const p = new SqlitePlugin();
        const cfg = { db_path: dbFile(), [key]: value } as unknown as BackendConfig;
        await expect(p.connect(cfg)).rejects.toThrow(
          new RegExp(`parley-sqlite:.*${key}`),
        );
      });
    }

    for (const value of GOOD_VALUES[key] ?? []) {
      it(`${key} = ${JSON.stringify(value)} is accepted`, async () => {
        await inScratchCwd(async () => {
          const p = new SqlitePlugin();
          open.push(p);
          const cfg = { db_path: dbFile(), [key]: value } as unknown as BackendConfig;
          await expect(p.connect(cfg)).resolves.toBeUndefined();
        });
      });
    }
  }

  it('a mistyped key is rejected rather than silently ignored', async () => {
    const p = new SqlitePlugin();
    await expect(
      p.connect({ db_path: dbFile(), retention_day: 30 } as unknown as BackendConfig),
    ).rejects.toThrow(/parley-sqlite: unknown backend_config key 'retention_day'/);
  });

  it('a rejected config deletes nothing', async () => {
    const path = dbFile();
    const writer = new SqlitePlugin();
    await writer.connect({ db_path: path, poll_interval_ms: 20 });
    await writer.post(T, me, 'precious');
    await writer.disconnect();

    for (const value of [0, -1, 'abc']) {
      const p = new SqlitePlugin();
      await expect(
        p.connect({ db_path: path, retention_days: value } as unknown as BackendConfig),
      ).rejects.toThrow(/retention_days/);
    }

    const reader = new SqlitePlugin();
    open.push(reader);
    await reader.connect({ db_path: path, poll_interval_ms: 20 });
    const { messages } = await reader.fetchRecent({ topic: T });
    expect(messages.map((m) => m.content)).toEqual(['precious']);
  });
});

/**
 * `BAD_VALUES` only ever probes a bound from far outside it (`1e308`), which any ceiling at all
 * rejects — so a bound could be re-tuned to a value that breaks what it exists to prevent and
 * nothing above would notice. These edges are READ FROM the exported constants rather than
 * restated, so re-tuning one re-grades its own accept/reject edge and a new bounded key is graded
 * by adding a row rather than by remembering to hand-pick four more literals.
 */
const BOUNDED_KEYS: Array<{ key: string; min: number; max: number; step: number }> = [
  { key: 'poll_interval_ms', min: MIN_POLL_INTERVAL_MS, max: MAX_POLL_INTERVAL_MS, step: 1 },
];

describe('every bounded knob is graded at its own edges', () => {
  for (const { key, min, max, step } of BOUNDED_KEYS) {
    for (const value of [min, Math.floor((min + max) / 2), max]) {
      it(`${key} = ${value} is accepted`, async () => {
        await inScratchCwd(async () => {
          const p = new SqlitePlugin();
          open.push(p);
          const cfg = { db_path: dbFile(), [key]: value } as unknown as BackendConfig;
          await expect(p.connect(cfg)).resolves.toBeUndefined();
        });
      });
    }

    for (const value of [min - step, max + step]) {
      it(`${key} = ${value} is rejected, naming both bounds`, async () => {
        const p = new SqlitePlugin();
        const cfg = { db_path: dbFile(), [key]: value } as unknown as BackendConfig;
        await expect(p.connect(cfg)).rejects.toThrow(
          new RegExp(`parley-sqlite: invalid backend_config\\.${key}.*${min}.*${max}`),
        );
      });
    }
  }
});

/**
 * Accepting a retention window is a promise to enforce it. A value whose cutoff lands outside the
 * representable date range used to pass validation and then fail every prune forever, leaving an
 * operator watching history grow while their config said otherwise.
 */
describe('every accepted retention_days actually prunes', () => {
  for (const days of [1 / 86_400_000, 0.5, 1, 30, 3650, 1e6]) {
    it(`retention_days = ${String(days)} runs a prune with no failure diagnostic`, async () => {
      const path = dbFile();
      const writer = new SqlitePlugin();
      await writer.connect({ db_path: path, poll_interval_ms: 20 });
      await writer.post(T, me, 'old');
      await writer.disconnect();
      await new Promise((r) => setTimeout(r, 5));

      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let lines: string[] = [];
      try {
        const p = new SqlitePlugin();
        open.push(p);
        await p.connect({ db_path: path, poll_interval_ms: 20, retention_days: days });
        lines = spy.mock.calls.map(([l]) => String(l));
      } finally {
        spy.mockRestore();
      }
      expect(lines.filter((l) => /retention prune failed/.test(l))).toEqual([]);
    });
  }

  for (const days of [1e308, 1e30, Number.MAX_VALUE]) {
    it(`retention_days = ${String(days)} is rejected rather than accepted-and-never-enforced`, async () => {
      const p = new SqlitePlugin();
      await expect(p.connect({ db_path: dbFile(), retention_days: days })).rejects.toThrow(
        /parley-sqlite: invalid backend_config.retention_days/,
      );
    });
  }
});
