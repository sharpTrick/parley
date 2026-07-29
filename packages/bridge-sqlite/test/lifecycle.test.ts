import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SqlitePlugin } from '../src/index.js';

/**
 * `connect`/`disconnect` are the entire lifecycle the seam declares, and an embedder — or a future
 * core reconnect path — will call them in orders the happy path never does. Every such order has to
 * either fail loudly or fully re-establish: a half-applied connect leaves poll loops delivering into
 * a store nobody reads, and `subscriptionHealth()` is what a supervisor decides to restart on, so a
 * loop that cannot deliver must never be reported as one that can.
 */

const T = asTopic('ctx');
const me = asHandle('alice');
const dbFile = () => join(mkdtempSync(join(tmpdir(), 'parley-life-')), 'p.db');

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

async function attempt(fn: () => Promise<unknown>): Promise<string | undefined> {
  try {
    await fn();
    return undefined;
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
}

interface Order {
  name: string;
  /** Drive the sequence; return the message the last (out-of-order) call threw, if any. */
  run: (p: SqlitePlugin, a: string, b: string, got: string[]) => Promise<string | undefined>;
  /** What the offending call must throw, or null if it must be accepted. */
  mustThrow: RegExp | null;
  /** Whether the plugin must still accept a `post` afterwards. */
  serving: boolean;
  /** Whether a loop subscribed before the offending call must still deliver afterwards. */
  loopDelivers: boolean;
}

const cfg = (path: string) => ({ db_path: path, poll_interval_ms: 10 });

const ORDERS: Order[] = [
  {
    name: 'connect then connect to another store',
    mustThrow: /already connected/,
    serving: true,
    loopDelivers: false,
    run: async (p, a, b) => {
      await p.connect(cfg(a));
      return attempt(() => p.connect(cfg(b)));
    },
  },
  {
    name: 'connect then connect to the same store',
    mustThrow: /already connected/,
    serving: true,
    loopDelivers: false,
    run: async (p, a) => {
      await p.connect(cfg(a));
      return attempt(() => p.connect(cfg(a)));
    },
  },
  {
    name: 'connect, subscribe, then connect to another store',
    mustThrow: /already connected/,
    serving: true,
    loopDelivers: true,
    run: async (p, a, b, got) => {
      await p.connect(cfg(a));
      for (let i = 0; i < 20; i++) await p.post(T, me, `history-${i}`);
      await p.subscribe(T, (m) => got.push(m.content));
      return attempt(() => p.connect(cfg(b)));
    },
  },
  {
    name: 'connect, subscribe, disconnect, connect again',
    mustThrow: null,
    serving: true,
    loopDelivers: false,
    run: async (p, a, b, got) => {
      await p.connect(cfg(a));
      await p.subscribe(T, (m) => got.push(m.content));
      await p.disconnect();
      return attempt(() => p.connect(cfg(b)));
    },
  },
  {
    name: 'connect, disconnect, disconnect',
    mustThrow: null,
    serving: false,
    loopDelivers: false,
    run: async (p, a) => {
      await p.connect(cfg(a));
      await p.disconnect();
      return attempt(() => p.disconnect());
    },
  },
  {
    name: 'subscribe after disconnect',
    mustThrow: /not connected/,
    serving: false,
    loopDelivers: false,
    run: async (p, a, _b, got) => {
      await p.connect(cfg(a));
      await p.disconnect();
      return attempt(() => p.subscribe(T, (m) => got.push(m.content)));
    },
  },
  {
    name: 'post after disconnect',
    mustThrow: /not connected/,
    serving: false,
    loopDelivers: false,
    run: async (p, a) => {
      await p.connect(cfg(a));
      await p.disconnect();
      return attempt(() => p.post(T, me, 'orphan'));
    },
  },
  {
    name: 'fetchRecent after disconnect',
    mustThrow: /not connected/,
    serving: false,
    loopDelivers: false,
    run: async (p, a) => {
      await p.connect(cfg(a));
      await p.disconnect();
      return attempt(() => p.fetchRecent({ topic: T }));
    },
  },
];

describe('a lifecycle call in an unexpected order fails loudly or fully re-establishes', () => {
  for (const order of ORDERS) {
    it(order.name, async () => {
      const p = tracked();
      const got: string[] = [];
      const threw = await order.run(p, dbFile(), dbFile(), got);

      if (order.mustThrow === null) {
        expect(threw).toBeUndefined();
      } else {
        expect(threw).toMatch(order.mustThrow);
        expect(threw).toMatch(/parley-sqlite|SqlitePlugin/);
      }

      const probeFailed = await attempt(() => p.post(T, me, 'probe'));
      expect(probeFailed === undefined).toBe(order.serving);

      if (order.loopDelivers) {
        await vi.waitFor(() => expect(got).toContain('probe'), { timeout: 2000, interval: 5 });
      } else {
        await new Promise((r) => setTimeout(r, 60));
        expect(got).not.toContain('probe');
      }

      // The health report is only worth reading if it cannot claim a loop that just failed to
      // deliver: nothing may say 'live' unless a post really did reach a handler.
      const live = p.subscriptionHealth().filter((h) => h.state === 'live');
      expect(live.length > 0).toBe(order.loopDelivers);
    });
  }
});

describe('subscriptionHealth never reports a loop that cannot deliver', () => {
  it('every live loop reads as stopped after disconnect, and stays that way', async () => {
    const p = tracked();
    await p.connect(cfg(dbFile()));
    const got: string[] = [];
    await p.subscribe(T, (m) => got.push(m.content));
    await p.subscribe(asTopic('other'), () => {});
    await p.post(T, me, 'while-live');
    await vi.waitFor(() => expect(got).toEqual(['while-live']), { timeout: 2000, interval: 5 });
    expect(p.subscriptionHealth().map((h) => h.state)).toEqual(['live', 'live']);

    await p.disconnect();

    const after = p.subscriptionHealth();
    expect(after.map((h) => h.topic)).toEqual(['ctx', 'other']);
    expect(after.map((h) => h.state)).toEqual(['stopped', 'stopped']);
    expect(after.every((h) => h.lastError !== undefined)).toBe(true);
    await new Promise((r) => setTimeout(r, 60));
    expect(p.subscriptionHealth().map((h) => h.state)).toEqual(['stopped', 'stopped']);
  });

  it('a reconnect reports nothing from the previous generation until it subscribes again', async () => {
    const path = dbFile();
    const p = tracked();
    await p.connect(cfg(path));
    await p.subscribe(T, () => {});
    await p.disconnect();

    await p.connect(cfg(path));
    expect(p.subscriptionHealth()).toEqual([]);

    const got: string[] = [];
    await p.subscribe(T, (m) => got.push(m.content));
    await p.post(T, me, 'second-generation');
    await vi.waitFor(() => expect(got).toEqual(['second-generation']), {
      timeout: 2000,
      interval: 5,
    });
    expect(p.subscriptionHealth().map((h) => h.state)).toEqual(['live']);
  });
});
