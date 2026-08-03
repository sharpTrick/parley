import { asCursor, asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import {
  dropTable,
  faultyProxy,
  isUp,
  PG_URL,
  rand,
  settleWithin,
  silentPeer,
  sleep,
} from './pg-harness.js';

// Class: a peer that is REACHABLE but not ANSWERING. TCP succeeds, so nothing errors; the bytes
// simply never come back. Every other failure this package grades announces itself — a refused
// connect, a killed backend, a lock timeout — and this one does not, which is why every wait it
// touches has to be bounded by this plugin rather than by the network eventually noticing.
//
// The property is ONE line and it is the same for every row: the call SETTLES. Not that it
// succeeds, not that it takes a particular number of milliseconds — a bridge whose seam call never
// comes back is indistinguishable from a wedged process, and `cli.ts` wires SIGINT/SIGTERM to
// `disconnect()`, so an unbounded teardown is a process only SIGKILL can remove.
//
// So the ceiling below is deliberately NOT derived from the plugin's own constants: a guard that
// reads the bound out of the code it is grading passes for any bound at all, including one a later
// change makes useless. It is the figure past which an operator stops calling it slow.
const SETTLE_CEILING_MS = 30_000;

/**
 * Cleanup only. Keep every `finally` bounded, so that a regression which hangs the teardown fails
 * on the assertion that names it rather than on a whole-test timeout that reports nothing — the
 * first version of this file lost exactly that diagnosis to a `finally` it had left unbounded.
 */
const CLEANUP_BUDGET_MS = 10_000;

// Every row also grades the teardown, because the teardown is where a socket that will not close
// gracefully is actually held: `pool.end()` and `Client.end()` both wait for a FIN that a black
// hole never sends. A row that only checked its own call would leave that half ungraded.
type Call = 'post' | 'fetchRecent' | 'subscribe' | 'resolveIdentity';

const CALLS: Call[] = ['post', 'fetchRecent', 'subscribe', 'resolveIdentity'];

/**
 * The calls whose parked wait is a STATEMENT, so they are holding a pool checkout that
 * `pool.end()` would otherwise wait out. `subscribe` is deliberately absent: what it parks on is
 * the listener dial, which is bounded by the same budget the teardown is, so which of the two
 * settles first is a coin toss rather than a property.
 */
const PARKED_ON_A_STATEMENT: Call[] = ['post', 'fetchRecent', 'resolveIdentity'];

function issue(plugin: PostgresPlugin, call: Call, topic: string): Promise<unknown> {
  switch (call) {
    case 'post':
      return plugin.post(asTopic(topic), asHandle('u'), 'after the peer went quiet');
    case 'fetchRecent':
      return plugin.fetchRecent({ topic: asTopic(topic), since: asCursor('0'), blockMs: 250 });
    case 'subscribe':
      return plugin.subscribe(asTopic(topic), () => undefined);
    default:
      return plugin.resolveIdentity(asHandle(`who-${topic}`));
  }
}

// The other half of "nothing here waits forever": nothing here CRASHES either. A socket that dies
// under a connection this plugin holds reaches Node as an 'error' event, and an 'error' with no
// listener is a process kill rather than a rejected command — the worst outcome for a plugin whose
// contract is that a dropped connection costs latency and never a message. Graded here for every
// row rather than in one case, because the window depends on what the driver is doing with the
// connection at the instant it dies, and each row leaves it doing something different.
const crashes: string[] = [];
const recordCrash = (err: unknown): void => {
  crashes.push(err instanceof Error ? err.message : String(err));
};

if (await isUp(PG_URL)) {
  beforeEach(() => {
    crashes.length = 0;
    process.on('uncaughtException', recordCrash);
  });

  afterEach(async () => {
    // A socket error surfaces a tick or two after the close that caused it.
    await sleep(100);
    process.off('uncaughtException', recordCrash);
    expect(crashes, 'a socket that died under this plugin escaped as an uncaughtException').toEqual(
      [],
    );
  });

  describe('a peer that accepts the socket and then never speaks settles every wait', () => {
    it('connect() gives up, names this plugin, and leaves the plugin reusable', async () => {
      const peer = await silentPeer();
      const plugin = new PostgresPlugin();
      const table = `parley_quiet_${rand()}`;
      try {
        const outcome = await settleWithin(plugin.connect({ url: peer.url }), SETTLE_CEILING_MS);
        expect(outcome, 'connect() never came back from a peer that never answered').not.toBe(
          'hung',
        );
        expect(outcome, 'the failure names neither the plugin nor what to check').toMatch(
          /^rejected: parley-postgres:/,
        );

        // A failed bootstrap that stranded its pool or left the in-flight guard armed would show up
        // only here: the supervisor's next act is another connect().
        await plugin.connect({ url: PG_URL, table_name: table });
        await plugin.post(asTopic('after-a-silent-peer'), asHandle('u'), 'works');
      } finally {
        await settleWithin(plugin.disconnect().catch(() => undefined), CLEANUP_BUDGET_MS);
        await peer.close();
        await dropTable(table);
      }
    }, 60000);

    it.each(CALLS)(
      '%s and the disconnect after it both settle once the peer goes quiet mid-session',
      async (call) => {
        const proxy = await faultyProxy();
        const plugin = new PostgresPlugin();
        const table = `parley_quiet_${rand()}`;
        const topic = `quiet-${rand()}`;
        try {
          await plugin.connect({ url: proxy.url, table_name: table });
          await plugin.post(asTopic(topic), asHandle('u'), 'before the peer went quiet');
          // A LIVE listener before the blackout, so the teardown below really has a socket that
          // will not close: `Client.end()` writes Terminate and waits for a FIN, and the whole
          // point of a black hole is that no FIN is coming. Without this the rows tear down a
          // plugin whose only connections are pooled, and pg-pool drops those without waiting.
          await plugin.subscribe(asTopic(`live-${topic}`), () => undefined);

          proxy.blackhole();
          const outcome = await settleWithin(
            issue(plugin, call, topic).catch(() => undefined),
            SETTLE_CEILING_MS,
          );
          expect(outcome, `${call}() never came back from a black-holed peer`).not.toBe('hung');

          const teardown = await settleWithin(plugin.disconnect(), SETTLE_CEILING_MS);
          expect(teardown, 'disconnect() never came back, so SIGTERM would not remove it').toBe(
            'resolved',
          );
        } finally {
          await settleWithin(plugin.disconnect().catch(() => undefined), CLEANUP_BUDGET_MS);
          await proxy.close();
          await dropTable(table);
        }
      },
      90000,
    );

    // `pool.end()` resolves only once every checked-out client is released, so a teardown that
    // simply awaits it inherits the wait of whatever seam call is still parked on the quiet peer.
    // Graded as an ORDER rather than a duration: the property is that teardown does not adopt
    // someone else's ceiling, and a number here would only restate whichever one the code picked.
    it.each(PARKED_ON_A_STATEMENT)(
      'disconnect() returns without waiting for a parked %s',
      async (call) => {
        const proxy = await faultyProxy();
        const plugin = new PostgresPlugin();
        const table = `parley_quiet_${rand()}`;
        const topic = `quiet-${rand()}`;
        const order: string[] = [];
        let parked: Promise<unknown> = Promise.resolve();
        try {
          await plugin.connect({ url: proxy.url, table_name: table });
          await plugin.post(asTopic(topic), asHandle('u'), 'before the peer went quiet');

          proxy.blackhole();
          parked = issue(plugin, call, topic)
            .catch(() => undefined)
            .finally(() => order.push(call));
          await sleep(250);

          const teardown = await settleWithin(
            plugin.disconnect().then(() => order.push('disconnect')),
            SETTLE_CEILING_MS,
          );
          expect(teardown, 'disconnect() never came back while a call was parked').toBe('resolved');
          expect(order[0], `disconnect() waited out the parked ${call}`).toBe('disconnect');
        } finally {
          await settleWithin(plugin.disconnect().catch(() => undefined), CLEANUP_BUDGET_MS);
          await proxy.close();
          await parked;
          await dropTable(table);
        }
      },
      90000,
    );

    // A socket the plugin has opened but not yet published is the third thing a teardown has to
    // close, and the one with no field pointing at it: `disconnect()` claims it out of the
    // in-flight set and ends it. A dial that will never complete is exactly the case that set
    // exists for, so it is also the case where an unbounded close there hangs the whole shutdown.
    it('disconnect() settles with a listener dial still stranded on the quiet peer', async () => {
      const proxy = await faultyProxy();
      const plugin = new PostgresPlugin();
      const table = `parley_quiet_${rand()}`;
      let dialling: Promise<unknown> = Promise.resolve();
      try {
        await plugin.connect({ url: proxy.url, table_name: table });
        proxy.refuseNew();
        dialling = plugin.subscribe(asTopic(`quiet-${rand()}`), () => undefined).catch(
          () => undefined,
        );
        await sleep(150);

        const teardown = await settleWithin(plugin.disconnect(), SETTLE_CEILING_MS);
        expect(teardown, 'disconnect() never came back with a dial still stranded').toBe('resolved');

        // The stranded dial settles AFTER the teardown returned, on the arm that releases its own
        // unadopted socket. Nothing it does then may reach the next lifecycle, and the only way to
        // see that is to run one: a resurrected registration makes subscribe() resolve without ever
        // issuing a LISTEN, so push is silently dead and only a delivered message tells them apart.
        proxy.admitNew();
        await plugin.connect({ url: PG_URL, table_name: table });
        const delivered: string[] = [];
        const topic = asTopic(`quiet-${rand()}`);
        await plugin.subscribe(topic, (m) => delivered.push(m.content));
        await plugin.post(topic, asHandle('u'), 'after the stranded dial');
        const deadline = Date.now() + 10000;
        while (delivered.length === 0 && Date.now() < deadline) await sleep(25);
        expect(delivered, 'the next lifecycle inherited the stranded dial').toEqual([
          'after the stranded dial',
        ]);
      } finally {
        await settleWithin(plugin.disconnect().catch(() => undefined), CLEANUP_BUDGET_MS);
        await proxy.close();
        await dialling;
        await dropTable(table);
      }
    }, 90000);

    // A write that failed because the answer never came back leaves its connection desynced from
    // the server's protocol stream — bytes were dropped mid-conversation — and, if the driver ever
    // answers the statement it thinks is still running, mid-transaction. Handing that back to the
    // pool poisons whoever checks it out next, so the failure outlives the outage that caused it.
    // Only a second write AFTER the network heals can tell a discarded connection from a reused one.
    it('a write that failed on the quiet peer does not poison the pool behind it', async () => {
      const proxy = await faultyProxy();
      const plugin = new PostgresPlugin();
      const table = `parley_quiet_${rand()}`;
      const topic = asTopic(`quiet-${rand()}`);
      try {
        // Keep `pool_size: 1`, so that the refused write cannot escape onto a FRESH connection:
        // with room to dial, the connect ceiling ends it instead and this row silently stops
        // grading the statement ceiling that is its whole subject.
        await plugin.connect({ url: proxy.url, table_name: table, pool_size: 1 });
        await plugin.post(topic, asHandle('u'), 'before the peer went quiet');

        proxy.blackhole();
        // Bounded like every other wait in this file, so that a write which never comes back at
        // all fails HERE, naming what did not return, instead of running the row out of its
        // vitest timeout — a timeout is indistinguishable from a loaded machine, so it attributes
        // nothing and costs a re-run to tell the two apart.
        const refused = await settleWithin(
          plugin.post(topic, asHandle('u'), 'lost').catch(() => undefined),
          SETTLE_CEILING_MS,
        );
        expect(refused, 'the write on the quiet peer never came back at all').not.toBe('hung');
        proxy.heal();

        const after = await settleWithin(
          plugin.post(topic, asHandle('u'), 'after the peer came back'),
          SETTLE_CEILING_MS,
        );
        expect(after, 'the next write inherited the failed one’s connection').toBe('resolved');
        const read = plugin.fetchRecent({ topic });
        expect(
          await settleWithin(read, SETTLE_CEILING_MS),
          'the read after the recovered write never came back',
        ).toBe('resolved');
        expect(
          (await read).messages.map((m) => m.content),
          'the recovered write is not in the table',
        ).toContain('after the peer came back');
      } finally {
        await settleWithin(plugin.disconnect().catch(() => undefined), CLEANUP_BUDGET_MS);
        await proxy.close();
        await dropTable(table);
      }
    }, 90000);

    // The listener dial is memoised, so a dial that never settles is not one slow call — it is
    // every later one. The only way to tell a memo that was cleared from one that was not is to
    // heal the network and ask again: a plugin that pinned the dead attempt answers the second
    // subscribe with the same "retry once the database is reachable again" that cannot come true.
    it('a listener dial that timed out does not outlive the outage that caused it', async () => {
      const proxy = await faultyProxy();
      const plugin = new PostgresPlugin();
      const table = `parley_quiet_${rand()}`;
      const first = `quiet-${rand()}`;
      const second = `quiet-${rand()}`;
      try {
        await plugin.connect({ url: proxy.url, table_name: table });

        proxy.refuseNew();
        const during = await settleWithin(
          plugin.subscribe(asTopic(first), () => undefined).catch(() => undefined),
          SETTLE_CEILING_MS,
        );
        expect(during, 'subscribe() never came back while the listener could not be dialled').not.toBe(
          'hung',
        );

        proxy.admitNew();
        await sleep(200);
        const delivered: string[] = [];
        const after = await settleWithin(
          plugin.subscribe(asTopic(second), (m) => delivered.push(m.content)),
          SETTLE_CEILING_MS,
        );
        expect(after, 'push stayed dead after the outage the listener dial was pinned by').toBe(
          'resolved',
        );

        // Resolving is a promise of a live path, and a memo that survived would be handing back a
        // registration whose LISTEN never happened — only a delivered message tells them apart.
        await plugin.post(asTopic(second), asHandle('u'), 'after the outage');
        const deadline = Date.now() + 10000;
        while (delivered.length === 0 && Date.now() < deadline) await sleep(25);
        expect(delivered, 'the subscribe that resolved never got a live path').toEqual([
          'after the outage',
        ]);
      } finally {
        await settleWithin(plugin.disconnect().catch(() => undefined), CLEANUP_BUDGET_MS);
        await proxy.close();
        await dropTable(table);
      }
    }, 90000);
  });
} else {
  describe.skip(`silent-peer bounds (no server at ${PG_URL})`, () => {
    it('skipped — start postgres (examples/dev-compose) to run', () => undefined);
  });
}
