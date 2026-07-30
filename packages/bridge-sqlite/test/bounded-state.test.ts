import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CATCHUP_LEDGER_MAX, SqlitePlugin } from '../src/index.js';

/**
 * Every seam call is keyed by a topic, and core admits any topic a `post_topics` pattern matches —
 * so the set of topics a caller can name at runtime is unbounded, in a process DESIGN §10 expects to
 * run for weeks. Per-topic state is therefore a leak unless it is bounded; core refuses the same
 * shape one layer up (`transport/push-loop.ts` keeps one flag rather than a per-topic ledger).
 *
 * Graded by walking the plugin's whole object rather than the one map that motivated it, so a
 * registry added to any entry point later is caught by the row that drives that entry point.
 */

const me = asHandle('alice');
const TOPICS = 2000;
const dbFile = () => join(mkdtempSync(join(tmpdir(), 'parley-bound-')), 'p.db');
/** Slow enough that 2000 concurrent loops do not spend the test querying, in the walk below. */
const cfg = (path: string) => ({ db_path: path, poll_interval_ms: 60_000 });
const fastCfg = (path: string) => ({ db_path: path, poll_interval_ms: 10 });

let open: SqlitePlugin[] = [];
function tracked(): SqlitePlugin {
  const p = new SqlitePlugin();
  open.push(p);
  return p;
}
afterEach(async () => {
  await Promise.all(open.map((p) => p.disconnect()));
  open = [];
});

const sizeOf = (v: unknown): number | undefined => {
  if (Array.isArray(v)) return v.length;
  if (v instanceof Map || v instanceof Set) return v.size;
  return undefined;
};

interface EntryPoint {
  name: string;
  drive: (p: SqlitePlugin, topic: Topic) => Promise<unknown>;
  /**
   * Collections this call is DECLARED to extend once per call, with the caller's own topic list as
   * the bound. `subscribe` is driven by the configured allowlist and its per-loop records are the
   * contract `subscriptionHealth()` publishes; everything else must stay bounded however many
   * distinct topics a caller names.
   */
  perCall: string[];
}

const ENTRY_POINTS: EntryPoint[] = [
  { name: 'fetchRecent', drive: (p, topic) => p.fetchRecent({ topic }), perCall: [] },
  { name: 'post', drive: (p, topic) => p.post(topic, me, 'x'), perCall: [] },
  {
    name: 'subscribe',
    drive: (p, topic) => p.subscribe(topic, () => {}),
    perCall: ['cancellers', 'health'],
  },
];

describe('no plugin state grows with the number of distinct topics a caller names', () => {
  for (const entry of ENTRY_POINTS) {
    it(`${TOPICS} distinct topics through ${entry.name}`, async () => {
      const p = tracked();
      await p.connect(cfg(dbFile()));
      for (let i = 0; i < TOPICS; i++) await entry.drive(p, asTopic(`ctx-${i}`));

      const collections = Object.entries(p as unknown as Record<string, unknown>)
        .map(([name, value]) => ({ name, size: sizeOf(value) }))
        .filter((c): c is { name: string; size: number } => c.size !== undefined);

      // A walk that finds nothing grades nothing, and a `perCall` name that no longer exists is a
      // row that stopped asserting the growth it was written for.
      expect(collections.length).toBeGreaterThan(0);
      expect(collections.map((c) => c.name)).toEqual(expect.arrayContaining(entry.perCall));

      for (const { name, size } of collections) {
        if (entry.perCall.includes(name)) {
          expect(size, `${name} must hold one record per ${entry.name}() call`).toBe(TOPICS);
        } else {
          expect(size, `${name} grew with the number of distinct topics`).toBeLessThanOrEqual(
            CATCHUP_LEDGER_MAX,
          );
        }
      }
    });
  }
});

/**
 * The bound costs something, and this is exactly what: the catch-up→live hand-off point survives
 * for as long as the ledger holds the topic, and an evicted topic's `subscribe` samples the tail —
 * the same start point a topic catch-up never read gets, so the message posted in between is left
 * to core's next catch-up instead of being pushed. Both arms are pinned, so replacing the eviction
 * with a `clear()` (which satisfies the bound above perfectly) reds here.
 */
describe('the catch-up hand-off survives until its topic is evicted', () => {
  const T = asTopic('ctx');
  const EVICTION = [
    {
      name: 'the ledger is exactly full',
      others: CATCHUP_LEDGER_MAX - 1,
      othersFirst: false,
      pushed: ['between'],
    },
    {
      name: 'one topic past full, this topic recorded first',
      others: CATCHUP_LEDGER_MAX,
      othersFirst: false,
      pushed: [],
    },
    {
      name: 'one topic past full, this topic recorded last',
      others: CATCHUP_LEDGER_MAX,
      othersFirst: true,
      pushed: ['between'],
    },
  ];

  for (const { name, others, othersFirst, pushed } of EVICTION) {
    it(`${name}: subscribe pushes ${JSON.stringify(pushed)}`, async () => {
      const p = tracked();
      await p.connect(fastCfg(dbFile()));
      const fetchOthers = async (): Promise<void> => {
        for (let i = 0; i < others; i++) await p.fetchRecent({ topic: asTopic(`ctx-${i}`) });
      };
      await p.post(T, me, 'history');
      if (othersFirst) await fetchOthers();
      await p.fetchRecent({ topic: T });
      await p.post(T, me, 'between');
      if (!othersFirst) await fetchOthers();

      const got: string[] = [];
      await p.subscribe(T, (m) => got.push(m.content));
      await p.post(T, me, 'after');
      await vi.waitFor(() => expect(got).toContain('after'), { timeout: 5000, interval: 5 });
      expect(got).toEqual([...pushed, 'after']);
    });
  }

  it('a topic whose hand-off keeps advancing outlives a flood of topics fetched once', async () => {
    const p = tracked();
    await p.connect(fastCfg(dbFile()));
    await p.post(T, me, 'history');
    await p.fetchRecent({ topic: T });
    for (let i = 0; i < CATCHUP_LEDGER_MAX - 1; i++) {
      await p.fetchRecent({ topic: asTopic(`ctx-${i}`) });
    }
    await p.post(T, me, 'read-again');
    await p.fetchRecent({ topic: T });
    await p.fetchRecent({ topic: asTopic('ctx-over') });
    await p.post(T, me, 'between');

    const got: string[] = [];
    await p.subscribe(T, (m) => got.push(m.content));
    await p.post(T, me, 'after');
    await vi.waitFor(() => expect(got).toContain('after'), { timeout: 5000, interval: 5 });
    expect(got).toEqual(['between', 'after']);
  });
});
