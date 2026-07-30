import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import type { SqlDriver } from '../src/driver.js';
import { retentionCutoff, SqlitePlugin } from '../src/index.js';

/**
 * Retention is the only irreversible thing this backend does, and which SIDE of the window it
 * deletes rests entirely on one subtraction. Every case here grades the RETAINED set as well as the
 * deleted one: a prune that deletes everything satisfies "the old rows are gone" perfectly, and
 * would wipe the whole shared file — every session's history — with no diagnostic at all.
 */

const T = asTopic('ctx');
const me = asHandle('alice');
const DAY_MS = 86_400_000;

const dirs: string[] = [];
function dbFile(): string {
  const d = mkdtempSync(join(tmpdir(), 'parley-retain-'));
  dirs.push(d);
  return join(d, 'p.db');
}

let open: SqlitePlugin[] = [];
afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
});
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/**
 * Expected cutoffs as literals against a frozen clock, so that no future rewrite of the arithmetic
 * can be graded by a restatement of itself. A days->ms slip, a `+` where a `-` belongs, or an
 * off-by-a-unit conversion each land here.
 */
describe('retentionCutoff resolves a window to a boundary in the past', () => {
  const NOW = '2026-07-30T12:00:00.000Z';
  const CUTOFFS: Array<{ days: number; expected: string }> = [
    { days: 1 / DAY_MS, expected: '2026-07-30T11:59:59.999Z' },
    { days: 0.5, expected: '2026-07-30T00:00:00.000Z' },
    { days: 1, expected: '2026-07-29T12:00:00.000Z' },
    { days: 30, expected: '2026-06-30T12:00:00.000Z' },
    { days: 3650, expected: '2016-08-01T12:00:00.000Z' },
  ];

  for (const { days, expected } of CUTOFFS) {
    it(`retention_days ${days} cuts at ${expected}`, () => {
      vi.useFakeTimers();
      vi.setSystemTime(NOW);
      try {
        expect(retentionCutoff(days)).toBe(expected);
      } finally {
        vi.useRealTimers();
      }
    });
  }

  it('every window cuts strictly before now, and a longer window cuts earlier', () => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
    try {
      const days = [1 / DAY_MS, 0.5, 1, 30, 365, 3650, 1e6];
      const cutoffs = days.map((d) => retentionCutoff(d));
      for (const c of cutoffs) expect(Date.parse(c)).toBeLessThan(Date.parse(NOW));
      expect(cutoffs).toEqual([...cutoffs].sort().reverse());
    } finally {
      vi.useRealTimers();
    }
  });
});

/**
 * (window x age of row) with BOTH arms asserted per cell. `0.9` and `1.1` of the window straddle the
 * boundary closely enough that a unit slip moves rows across it, and the shortest window here is a
 * minute — long enough that a row "just posted" is unambiguously inside it.
 */
describe('a prune deletes rows outside the window and keeps every row inside it', () => {
  const AGES = [
    { name: 'just-posted', fraction: 0, survives: true },
    { name: 'half-a-window', fraction: 0.5, survives: true },
    { name: 'just-inside', fraction: 0.9, survives: true },
    { name: 'just-outside', fraction: 1.1, survives: false },
    { name: 'ten-windows', fraction: 10, survives: false },
  ];
  const WINDOWS_IN_DAYS = [1 / 1440, 1 / 24, 1, 30, 3650];

  function plant(p: SqlitePlugin, windowDays: number, tag: string): void {
    const stmt = (p as unknown as { driver: SqlDriver }).driver.prepare(
      'INSERT INTO messages (topic, sender, content, ts) VALUES (?, ?, ?, ?)',
    );
    for (const age of AGES) {
      const ts = new Date(Date.now() - age.fraction * windowDays * DAY_MS).toISOString();
      stmt.run(T, me, `${tag}:${age.name}`, ts);
    }
  }

  const survivors = (tag: string): string[] =>
    AGES.filter((a) => a.survives).map((a) => `${tag}:${a.name}`);

  for (const windowDays of WINDOWS_IN_DAYS) {
    it(`retention_days ${windowDays} keeps ${survivors('x').length} of ${AGES.length} planted rows`, async () => {
      const path = dbFile();
      const writer = new SqlitePlugin();
      await writer.connect({ db_path: path, poll_interval_ms: 20 });
      plant(writer, windowDays, 'seeded');
      await writer.disconnect();

      const p = new SqlitePlugin();
      open.push(p);
      const spy = vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      let lines: string[] = [];
      try {
        await p.connect({ db_path: path, poll_interval_ms: 20, retention_days: windowDays });
        lines = spy.mock.calls.map(([l]) => String(l));
      } finally {
        spy.mockRestore();
      }
      expect(lines.filter((l) => /retention prune failed/.test(l))).toEqual([]);

      const afterConnect = await p.fetchRecent({ topic: T, limit: 100 });
      expect(afterConnect.messages.map((m) => m.content)).toEqual(survivors('seeded'));

      // The hourly timer runs the same statement against rows that aged in since connect, so the
      // boundary has to hold on that path too, not only on the one connect happens to take.
      plant(p, windowDays, 'later');
      (p as unknown as { prune(): void }).prune();
      const afterTimer = await p.fetchRecent({ topic: T, limit: 100 });
      expect(afterTimer.messages.map((m) => m.content).sort()).toEqual(
        [...survivors('seeded'), ...survivors('later')].sort(),
      );
    });
  }
});
