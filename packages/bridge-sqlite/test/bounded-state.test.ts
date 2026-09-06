import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it } from 'vitest';
import { SqlitePlugin } from '../src/index.js';

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

/**
 * What a collection that is NOT one record per call may hold. Deliberately far below
 * {@link TOPICS}: nothing in the plugin is keyed by topic any more, so a ledger reintroduced here
 * reds whatever cap is written beside it, instead of being admitted by one sized to fit it.
 */
const NOT_PER_TOPIC = 8;

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
            NOT_PER_TOPIC,
          );
        }
      }
    });
  }
});
