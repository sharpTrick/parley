import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asHandle, asTopic, type BackendConfig } from '@sharptrick/parley-core';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  MAX_POLL_INTERVAL_MS,
  MIN_POLL_INTERVAL_MS,
  MIN_RETENTION_DAYS,
  SqlitePlugin,
} from '../src/index.js';

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
 * `db_path` is handed to two drivers that do not agree on what a string means: node:sqlite resolves
 * SQLite URIs, better-sqlite3 opens a file literally named after one. A value they read differently
 * therefore names a DIFFERENT store per install, with neither driver raising anything — so it is
 * refused at the config, before a file can be created under either reading. Each row grades the
 * refusal and that the cwd is untouched: a guard that fired after the open would leave behind the
 * very file it exists to prevent, and the message alone cannot tell those apart.
 */
describe('a db_path the two drivers would read differently is refused before anything opens', () => {
  const AMBIGUOUS = [
    'file::memory:',
    'file::memory:?cache=shared',
    'file:p.db',
    'file:p.db?mode=ro',
    'file:./p.db?cache=private',
  ];

  for (const value of AMBIGUOUS) {
    it(`${JSON.stringify(value)} is refused, naming the key, and creates nothing`, async () => {
      await inScratchCwd(async () => {
        const here = process.cwd();
        const p = new SqlitePlugin();
        await expect(p.connect({ db_path: value })).rejects.toThrow(
          /parley-sqlite: invalid backend_config\.db_path/,
        );
        expect(readdirSync(here), `a store was created under one driver'"'"'s reading of ${value}`).toEqual([]);
      });
    });
  }

  // The other side of the same guard: a path is not ambiguous merely for containing a colon, and a
  // table that rejects everything grades nothing.
  for (const value of ['p.db', 'not-a-file:uri.db', './sub-dir-free.db', ':memory:']) {
    it(`${JSON.stringify(value)} is still accepted`, async () => {
      await inScratchCwd(async () => {
        const p = new SqlitePlugin();
        open.push(p);
        await expect(p.connect({ db_path: value })).resolves.toBeUndefined();
        await expect(p.post(T, me, 'operable')).resolves.toBeDefined();
      });
    });
  }
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
 * `retention_days` is the only irreversible knob, and its guard used to name the SENTINEL instead of
 * the hazard: `0` and negatives were refused for "would delete the entire history" while
 * `Number.MIN_VALUE` and `1e-9` were accepted and did exactly that on the prune `connect()` runs
 * immediately. So the accepted arm asserts the STORE, not that connect resolved — "no prune-failure
 * diagnostic" is what let the class through, since a message planted inside every window under test
 * cannot tell "prunes correctly" from "does not prune at all". Which side of a window a prune
 * deletes is retention-window.test.ts's (window x age) table; this one owns the accept/reject edge.
 *
 * The edges are READ FROM {@link MIN_RETENTION_DAYS} rather than restated, so re-tuning the floor
 * re-grades its own boundary instead of quietly moving out from under these rows.
 */
describe('the retention_days floor rejects every window that empties the store', () => {
  const REJECTED = [
    0,
    -1,
    Number.MIN_VALUE,
    1e-12,
    1e-9,
    1 / 86_400_000,
    MIN_RETENTION_DAYS / 2,
    1e30,
    1e308,
    Number.MAX_VALUE,
  ];
  const ACCEPTED = [MIN_RETENTION_DAYS, MIN_RETENTION_DAYS * 1.5, 0.5, 1, 30, 3650, 1e6];

  for (const days of REJECTED) {
    it(`retention_days = ${String(days)} is refused, naming the key and the floor`, async () => {
      const path = dbFile();
      const writer = new SqlitePlugin();
      await writer.connect({ db_path: path, poll_interval_ms: 20 });
      await writer.post(T, me, 'precious');
      await writer.disconnect();

      const p = new SqlitePlugin();
      await expect(p.connect({ db_path: path, poll_interval_ms: 20, retention_days: days })).rejects
        .toThrow(/parley-sqlite: invalid backend_config\.retention_days/);

      const reader = new SqlitePlugin();
      open.push(reader);
      await reader.connect({ db_path: path, poll_interval_ms: 20 });
      const { messages } = await reader.fetchRecent({ topic: T });
      expect(messages.map((m) => m.content)).toEqual(['precious']);
    });
  }

  for (const days of ACCEPTED) {
    it(`retention_days = ${String(days)} is accepted and leaves a message posted just now alone`, async () => {
      const path = dbFile();
      const writer = new SqlitePlugin();
      await writer.connect({ db_path: path, poll_interval_ms: 20 });
      await writer.post(T, me, 'precious');
      await writer.disconnect();

      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let lines: string[] = [];
      const p = new SqlitePlugin();
      open.push(p);
      try {
        await expect(
          p.connect({ db_path: path, poll_interval_ms: 20, retention_days: days }),
        ).resolves.toBeUndefined();
        lines = spy.mock.calls.map(([l]) => String(l));
      } finally {
        spy.mockRestore();
      }
      // An accepted window is also a promise the process can KEEP: a cutoff outside the
      // representable date range used to validate and then fail every prune forever.
      expect(lines.filter((l) => /retention prune failed/.test(l))).toEqual([]);
      const { messages } = await p.fetchRecent({ topic: T });
      expect(messages.map((m) => m.content)).toEqual(['precious']);
    });
  }
});
