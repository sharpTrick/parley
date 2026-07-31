import { asCursor, asTopic, type Message } from '@sharptrick/parley-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import { channelFor } from '../src/schema.js';
import { sleep } from './pg-harness.js';

// NOTIFY is EDGE-triggered: a row already committed reaches a live handler only because some drain
// reads past `lastSeen` and finds it. So every place the live path swallows a failed read is a
// place where a durably stored message is dropped from push until an unrelated later post happens
// to ring the same doorbell — which, on a quiet topic, may never happen. Nothing surfaces: no
// handler call, no error, no reconnect.
//
// The class this file guards is 'a transient backend failure on the push path is silently
// terminal', driven over WHERE the read fails x HOW LONG it keeps failing x whether a doorbell ever
// rings again. The 'never rings again' column is the one that discriminates: with a doorbell after
// recovery even a live path with no self-heal at all delivers, so a suite that only ever rings
// again grades nothing.

const state = vi.hoisted(() => ({
  clients: [] as MockShape[],
  /** The table, per topic — what a recovered read must actually come back with. */
  rows: new Map<string, Record<string, unknown>[]>(),
  /** Remaining windowed reads to reject; `Infinity` until `healAt` passes. */
  failReads: 0,
  /** When non-zero, windowed reads reject until this timestamp rather than by count. */
  healAt: 0,
  /** Windowed reads served or rejected, so a cell can prove a read was actually attempted. */
  reads: 0,
  /** Set to park the Nth windowed read (1-based) until released — the teardown window. */
  gateRead: 0,
  gate: null as null | Promise<void>,
  releaseGate: null as null | (() => void),
  /** When set, the gated read rejects once released — only that read, whatever else is armed. */
  gateRejects: false,
}));

interface MockShape {
  emit: (event: string, arg?: unknown) => boolean;
}

vi.mock('pg', async () => {
  const { FakeEmitter, fakePool, servePool } = await import('./fake-pg.js');

  class MockClient extends FakeEmitter implements MockShape {
    constructor() {
      super();
      state.clients.push(this);
    }
    async connect(): Promise<void> {}
    async query(): Promise<{ rows: unknown[] }> {
      return { rows: [] };
    }
    async end(): Promise<void> {}
  }

  return {
    Pool: vi.fn(() =>
      fakePool(async (sql, values) => {
        // Only the cursor-windowed read — the one every live path runs — is failed here. The tail
        // `MAX(seq)` read is subscribe's, and failing it would grade a different seam call.
        if (!/seq > \$\d+::bigint/.test(sql)) {
          return { rows: servePool(state.rows.get(String(values[0])) ?? [], sql, values) ?? [] };
        }
        state.reads++;
        if (state.reads === state.gateRead && state.gate !== null) {
          await state.gate;
          if (state.gateRejects) throw new Error('terminating connection due to administrator command');
        }
        const failing = state.healAt > 0 ? Date.now() < state.healAt : state.failReads > 0;
        if (failing) {
          if (state.healAt === 0) state.failReads--;
          throw new Error('terminating connection due to administrator command');
        }
        return { rows: servePool(state.rows.get(String(values[0])) ?? [], sql, values) ?? [] };
      }),
    ),
    Client: MockClient,
  };
});

const URL = 'postgres://app:s3cret@db.example.com:5432/prod';

/** How long a cell gives the plugin to converge on its own — well past the backoff it needs. */
const CONVERGE_MS = 4000;
/** How long a time-driven outage lasts before the pool answers again. */
const OUTAGE_MS = 400;

async function until(pred: () => boolean, budgetMs = CONVERGE_MS): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (!pred() && Date.now() < deadline) await sleep(5);
}

function seed(topic: string, content: string): void {
  state.rows.set(topic, [
    {
      seq: '1',
      topic,
      sender: 'u',
      content,
      ts: new Date().toISOString(),
      in_reply_to: null,
    },
  ]);
}

/** Every place the live path issues a cursor-windowed read and swallows its failure. */
type Site =
  | 'the drain a NOTIFY starts'
  | 'the re-drain the listener reconnect starts'
  | "a blocking waiter's snapshot re-check";

type Outage = 'one read' | 'three reads' | 'until the server recovers';
/**
 * Whether anything ever re-rings the doorbell for this topic, and when. All three are reachable
 * deployments and each grades a different mechanism: with no further ring the live path has only
 * its own recovery to converge on; a ring that lands while the failing read is still in flight is
 * coalesced into `pending`, which the throw discards; and a ring after recovery must deliver the
 * row exactly once rather than a second copy of a row the recovery already handed over.
 */
type Doorbell =
  | 'no doorbell ever rings again'
  | 'a doorbell rings while the failing read is in flight'
  | 'a doorbell rings once after recovery';

const OUTAGES: Outage[] = ['one read', 'three reads', 'until the server recovers'];
const DOORBELLS: Doorbell[] = [
  'no doorbell ever rings again',
  'a doorbell rings while the failing read is in flight',
  'a doorbell rings once after recovery',
];

interface Cell {
  site: Site;
  outage: Outage;
  doorbell: Doorbell;
}

/**
 * The waiter's re-check is issued exactly ONCE per wait and has no doorbell of its own to coalesce
 * — waiters.test.ts owns every way a ring reaches a parked fetch — so it carries neither dimension.
 */
const CELLS: Cell[] = [
  ...(['the drain a NOTIFY starts', 'the re-drain the listener reconnect starts'] as Site[]).flatMap(
    (site) => OUTAGES.flatMap((outage) => DOORBELLS.map((doorbell) => ({ site, outage, doorbell }))),
  ),
  {
    site: "a blocking waiter's snapshot re-check",
    outage: 'one read',
    doorbell: 'no doorbell ever rings again',
  },
];

function armOutage(cell: Cell): void {
  if (cell.outage === 'until the server recovers') {
    state.healAt = Date.now() + OUTAGE_MS;
  } else {
    state.failReads = cell.outage === 'one read' ? 1 : 3;
  }
}

function outageOver(): boolean {
  return state.healAt > 0 ? Date.now() >= state.healAt : state.failReads === 0;
}

beforeEach(() => {
  state.clients = [];
  state.rows.clear();
  state.failReads = 0;
  state.healAt = 0;
  state.reads = 0;
  state.gateRead = 0;
  state.gate = null;
  state.releaseGate = null;
  state.gateRejects = false;
});

describe('a transient read failure on the push path is recovered from, not dropped', () => {
  it('the fake really does reject a windowed read, so the cells below can fail', async () => {
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: URL });
    state.failReads = 1;
    await expect(
      plugin.fetchRecent({ topic: asTopic('t'), since: asCursor('0') }),
    ).rejects.toThrow(/administrator command/);
    await plugin.disconnect();
  });

  it.each(CELLS.map((c) => [`${c.site}, failing for ${c.outage}, ${c.doorbell}`, c] as const))(
    '%s',
    async (_label, cell) => {
      const topic = asTopic('quiet');
      const channel = channelFor(topic);
      const plugin = new PostgresPlugin();
      await plugin.connect({ url: URL, table_name: 'parley_sh' });
      const got: Message[] = [];
      const waiterPage: Message[][] = [];
      try {
        if (cell.site === "a blocking waiter's snapshot re-check") {
          // The wait's own re-check is the SECOND windowed read (the first is fetchRecent's initial
          // exclusive query). Park it, so the row and the outage are both in place before it runs.
          state.gateRead = 2;
          state.gate = new Promise<void>((resolve) => {
            state.releaseGate = resolve;
          });
          const parked = plugin
            .fetchRecent({ topic, since: asCursor('0'), blockMs: 500 })
            .then((page) => {
              waiterPage.push(page.messages);
            });
          await until(() => state.reads >= 2);
          seed(String(topic), 'lost');
          armOutage(cell);
          state.releaseGate?.();
          await parked;
          expect(waiterPage[0]?.map((m) => m.content), 'the blocked fetch never saw the row').toEqual(
            ['lost'],
          );
          return;
        }

        await plugin.subscribe(topic, (m) => got.push(m));
        // The subscribe's own drain must settle before the outage is armed, so the read this cell
        // fails is the one its site names.
        await until(() => state.reads >= 1);
        await sleep(20);
        const readsBefore = state.reads;

        seed(String(topic), 'lost');
        armOutage(cell);
        const ring = (): void => {
          state.clients.at(-1)?.emit('notification', { channel });
        };
        if (cell.doorbell === 'a doorbell rings while the failing read is in flight') {
          state.gateRead = state.reads + 1;
          state.gate = new Promise<void>((resolve) => {
            state.releaseGate = resolve;
          });
        }

        if (cell.site === 'the drain a NOTIFY starts') ring();
        else state.clients.at(-1)?.emit('end');

        await until(() => state.reads > readsBefore, 3000);
        expect(state.reads, 'no read was attempted, so this cell proves nothing').toBeGreaterThan(
          readsBefore,
        );
        if (cell.doorbell === 'a doorbell rings while the failing read is in flight') {
          ring();
          state.releaseGate?.();
        }
        await until(() => outageOver());
        if (cell.doorbell === 'a doorbell rings once after recovery') {
          // Past the failed drain's own settle, so this is a genuine later edge and not one more
          // notification coalesced into the drain that is about to throw.
          await sleep(30);
          ring();
        }

        await until(() => got.length > 0);
        expect(
          got.map((m) => m.content),
          'a committed row never reached the live handler after the read recovered',
        ).toEqual(['lost']);
        expect(String(got[0]?.backendMsgId)).toBe('1');
      } finally {
        state.releaseGate?.();
        await plugin.disconnect().catch(() => undefined);
      }
    },
    20000,
  );
});

// A backoff that only ever grows turns one blip an hour into a subscription that takes the ceiling
// gap to recover from the NEXT one, so the gap has to come back down when a drain succeeds.
describe('the re-drain backoff resets once a drain succeeds', () => {
  it('a recovered subscription is back at the base gap', async () => {
    const topic = asTopic('quiet');
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: URL, table_name: 'parley_sh' });
    const got: Message[] = [];
    await plugin.subscribe(topic, (m) => got.push(m));
    await until(() => state.reads >= 1);
    await sleep(20);

    seed(String(topic), 'lost');
    state.failReads = 3;
    state.clients.at(-1)?.emit('notification', { channel: channelFor(topic) });
    await until(() => got.length > 0);
    expect(got.map((m) => m.content)).toEqual(['lost']);

    const subs = (plugin as unknown as { subs: Map<string, { retryDelayMs?: number }> }).subs;
    expect(
      [...subs.values()].map((s) => s.retryDelayMs),
      'the escalated backoff outlived the outage that caused it',
    ).toEqual([undefined]);

    await plugin.disconnect();
  }, 20000);
});

// The re-drain is a timer, and a timer is the one chore shape that can outlive the lifecycle that
// armed it. Both halves are load-bearing and fail differently: `disconnect()` cancels a retry that
// was already armed, and the arming itself refuses to run for a lifecycle that has ended — a drain
// read rejecting AFTER the teardown reaches the same catch. Either one missing hands a torn-down
// session's handlers one more batch, read off the SUCCESSOR lifecycle's pool.

type Race = 'armed before disconnect' | 'the failing read lands after disconnect';

const RACES: Race[] = ['armed before disconnect', 'the failing read lands after disconnect'];

/**
 * Long enough that a re-drain armed before the teardown is still pending while the successor
 * lifecycle is built — a leaked timer then has a working pool to read off and a stale handler list
 * to deliver into, instead of firing into the gap where `stopped` alone would have stopped it.
 */
const ESCALATED_FAILURES = 4;

describe('a re-drain never crosses a teardown', () => {
  it.each(RACES.map((race) => [race, race] as const))('%s', async (_label, race) => {
    const topic = asTopic('quiet');
    const channel = channelFor(topic);
    const plugin = new PostgresPlugin();
    await plugin.connect({ url: URL, table_name: 'parley_sh' });
    const orphaned: Message[] = [];
    await plugin.subscribe(topic, (m) => orphaned.push(m));
    await until(() => state.reads >= 1);
    await sleep(20);
    const readsBefore = state.reads;

    if (race === 'armed before disconnect') {
      // Keep the pool down across several retries, so the backoff has escalated and the timer
      // pending at the teardown is one this test can outlast deterministically.
      state.healAt = Date.now() + 60_000;
      state.clients.at(-1)?.emit('notification', { channel });
      await until(() => state.reads >= readsBefore + ESCALATED_FAILURES);
    } else {
      state.gateRead = readsBefore + 1;
      state.gateRejects = true;
      state.gate = new Promise<void>((resolve) => {
        state.releaseGate = resolve;
      });
      state.clients.at(-1)?.emit('notification', { channel });
      await until(() => state.reads === state.gateRead);
    }

    await plugin.disconnect();
    state.healAt = 0;

    // The successor is a live plugin with its own pool, and it is up BEFORE the orphaned re-drain
    // can fire — so a retry that survived the teardown has somewhere real to deliver.
    await plugin.connect({ url: URL, table_name: 'parley_sh' });
    const successor: Message[] = [];
    await plugin.subscribe(topic, (m) => successor.push(m));
    seed(String(topic), 'after-teardown');
    // Only now does the drain parked at the teardown reach its catch.
    state.releaseGate?.();
    await sleep(900);

    expect(
      orphaned.map((m) => m.content),
      'a re-drain fanned a batch out to a torn-down lifecycle',
    ).toEqual([]);

    state.clients.at(-1)?.emit('notification', { channel });
    await until(() => successor.length > 0);
    expect(successor.map((m) => m.content), 'push is dead in the successor lifecycle').toEqual([
      'after-teardown',
    ]);

    await plugin.disconnect();
  }, 20000);
});
