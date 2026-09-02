import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { PostgresPlugin } from '../src/index.js';
import {
  dropTable,
  type FaultyProxy,
  faultyProxy,
  isUp,
  PG_URL,
  rand,
  settledSockets,
  settleWithin,
  sleep,
  watchSockets,
} from './pg-harness.js';

// `disconnect()` returning and the connections it was closing being GONE are two different claims,
// and this package graded only the first. Every teardown case here asserted a settle — an order, a
// duration, a server-side backend count that a killed peer clears on its own — and all of them are
// satisfied by a teardown that hit its deadline and walked away from a live socket. So the whole
// give-up half of `endWithin` could be replaced by a no-op with the suite still green, which is
// exactly what it was.
//
// The census below is the missing claim, and it is total by construction rather than by a list: it
// counts every socket this process dialled at the fault and has not destroyed, so a connection kind
// this plugin grows later is graded the moment it dials. The rows differ only in what the plugin is
// holding when the shutdown arrives.

const up = await isUp(PG_URL);

/** Bounded like every wait here, so a teardown that hangs fails by name and not by file timeout. */
const SETTLE_CEILING_MS = 30_000;
const CLEANUP_BUDGET_MS = 10_000;

/**
 * How long a socket gets to finish unwinding after `disconnect()` returned. Kept far under the
 * statement ceiling a parked call sits out, so that a connection which survives the teardown and is
 * cleaned up later by the DRIVER's own timeout still fails this — that outcome is the leak.
 */
const UNWIND_GRACE_MS = 2000;

interface Holding {
  /** What the plugin is holding when the shutdown arrives. */
  holds: string;
  /** A seam call parked on a statement the peer is never going to answer. */
  parked: boolean;
  /** The shared LISTEN connection, which is a plain client and not a pooled one. */
  listening: boolean;
}

/**
 * Stated per row rather than read out of the label, so that renaming a row cannot quietly stop it
 * building the connection it is named for while its census still passes on the other one.
 */
const HOLDINGS: Holding[] = [
  { holds: 'an idle pooled connection', parked: false, listening: false },
  { holds: 'a pooled connection parked on a statement', parked: true, listening: false },
  { holds: 'a listener with a live subscription', parked: false, listening: true },
  { holds: 'a listener and a parked statement together', parked: true, listening: true },
];

/**
 * Bring the plugin to `holding` and black-hole the peer under it. Hands the parked call back inside
 * a box, so that a row can wait for it in cleanup rather than leaving its rejection to land in the
 * next test — and, keep the box, so that awaiting this call cannot flatten into awaiting the parked
 * one, which silently turns every parked row into a census taken after the wait it exists to skip.
 */
async function arrive(
  plugin: PostgresPlugin,
  proxy: FaultyProxy,
  holding: Holding,
  topic: string,
): Promise<{ parked: Promise<unknown> }> {
  await plugin.post(asTopic(topic), asHandle('u'), 'before the peer went quiet');
  if (holding.listening) await plugin.subscribe(asTopic(`live-${topic}`), () => undefined);
  proxy.blackhole();
  if (!holding.parked) return { parked: Promise.resolve() };
  const parked = plugin.post(asTopic(topic), asHandle('u'), 'lost').catch(() => undefined);
  await sleep(250);
  return { parked };
}

describe.skipIf(!up)('a teardown leaves no connection behind, whatever it was holding', () => {
  it.each(HOLDINGS.map((h) => [h.holds, h] as const))(
    'disconnect() with %s open destroys it rather than abandoning it',
    async (_label, holding) => {
      const proxy = await faultyProxy();
      const port = Number(new URL(proxy.url).port);
      const watch = watchSockets();
      const plugin = new PostgresPlugin();
      const table = `parley_sockets_${rand()}`;
      const topic = `sockets-${rand()}`;
      let parked: Promise<unknown> = Promise.resolve();
      try {
        // Keep `pool_size: 1`, so that the parked write is holding the pool's ONLY connection and
        // the teardown really has a checked-out client to deal with: with room to dial, the pool
        // hands the write a second connection and the row stops grading the case it is named for.
        await plugin.connect({ url: proxy.url, table_name: table, pool_size: 1 });
        parked = (await arrive(plugin, proxy, holding, topic)).parked;

        expect(
          watch.openTo(port),
          'the plugin is holding no connection at all, so this row would pass on any teardown',
        ).toBeGreaterThan(0);

        const teardown = await settleWithin(plugin.disconnect(), SETTLE_CEILING_MS);
        expect(teardown, 'disconnect() never came back, so what it left open cannot be graded').toBe(
          'resolved',
        );
        expect(
          await settledSockets(watch, port, UNWIND_GRACE_MS),
          'disconnect() returned with a live connection to the black hole still open',
        ).toBe(0);
      } finally {
        watch.stop();
        await settleWithin(plugin.disconnect().catch(() => undefined), CLEANUP_BUDGET_MS);
        await proxy.close();
        await parked;
        await dropTable(table);
      }
    },
    90000,
  );

  // The same census on the path every shutdown actually takes. A give-up that destroys sockets is
  // only half the property: a teardown must also not RETURN from a graceful close while the socket
  // it closed gracefully is still open, which is what `pool.end()` resolving does.
  it('disconnect() against a peer that is still answering leaves nothing connected either', async () => {
    const proxy = await faultyProxy();
    const port = Number(new URL(proxy.url).port);
    const watch = watchSockets();
    const plugin = new PostgresPlugin();
    const table = `parley_sockets_${rand()}`;
    const topic = `sockets-${rand()}`;
    try {
      await plugin.connect({ url: proxy.url, table_name: table, pool_size: 1 });
      await plugin.post(asTopic(topic), asHandle('u'), 'while the peer was answering');
      await plugin.subscribe(asTopic(`live-${topic}`), () => undefined);

      expect(
        watch.openTo(port),
        'the plugin is holding no connection at all, so this row would pass on any teardown',
      ).toBeGreaterThan(0);

      const teardown = await settleWithin(plugin.disconnect(), SETTLE_CEILING_MS);
      expect(teardown, 'disconnect() never came back from a peer that was answering').toBe(
        'resolved',
      );
      expect(
        await settledSockets(watch, port, UNWIND_GRACE_MS),
        'disconnect() returned with a connection to the database still open',
      ).toBe(0);
    } finally {
      watch.stop();
      await settleWithin(plugin.disconnect().catch(() => undefined), CLEANUP_BUDGET_MS);
      await proxy.close();
      await dropTable(table);
    }
  }, 90000);
});
