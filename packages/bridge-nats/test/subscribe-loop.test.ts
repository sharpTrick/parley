import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { attachConnection, fakeJetStream, injectFake, payload } from './fake-jetstream.js';
import { waitFor } from './helpers.js';

// Class 1: the live loop must rebuild after EVERY unplanned end of the message iterator, not only
// after an explicit ConsumerDeleted/NotFound status event — a dropped link ends `consume()` with no
// event at all, and a loop that only rebuilds on the event goes silently deaf. Only `disconnect()`
// (or a permanently closed connection) may end it. The transport is faked because a healthy server
// will not produce a silent EOF on demand.
// Class 2: the iterator does not have to END for delivery to have been lost. `AckPolicy.None` makes
// the server's write to the link the delivery, so a message it wrote while the link was already
// gone is never resent, and the only trace is a hole in `info.deliverySequence`. The hole table is
// ENUMERATED, not hand-picked — every non-empty set of positions in a run, on the original consumer
// and on a rebuilt one — because a loop that exempts any position (the first delivery especially,
// which has no predecessor to compare against) goes deaf for everything behind that hole.

const SWALLOW = asTopic('swallow');
const REBORN = asTopic('reborn');
const SILENT = asTopic('silent');

const RUN = 4;
/** Every non-empty subset of `items`. */
const subsets = <T>(items: T[]): T[][] =>
  items.reduce<T[][]>((acc, item) => [...acc, ...acc.map((s) => [...s, item])], [[]]).slice(1);
// The run's LAST message can hold no detectable hole: nothing follows it to expose the jump.
const holes = subsets(Array.from({ length: RUN - 1 }, (_, i) => i + 1));
const every = Array.from({ length: RUN }, (_, i) => `m${i + 1}`);

describe('nats subscribe loop — a swallowed delivery is recovered', () => {
  for (const swallowed of holes) {
    for (const generation of [1, 2]) {
      it(`redelivers when consumer ${generation} swallowed ${swallowed.join('+')}`, async () => {
        const fake = fakeJetStream({
          records: [],
          swallowed,
          swallowGeneration: generation,
          silentExits: generation - 1, // reach a REBUILT consumer before injecting the hole
        });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, SWALLOW);
        attachConnection(plugin);

        const got: string[] = [];
        await plugin.subscribe(SWALLOW, (m) => {
          got.push(m.content);
        });
        for (let seq = 1; seq <= RUN; seq++) {
          fake.state.records.push({ seq, data: payload(`m${seq}`) });
        }

        await waitFor(() => every.every((c) => got.includes(c)), 15000);
        expect([...new Set(got)].sort()).toEqual([...every].sort());
        expect(fake.state.created.length).toBeGreaterThan(generation);

        await plugin.disconnect();
      }, 25_000);
    }
  }

  it('does not rebuild when every delivery arrives', async () => {
    const fake = fakeJetStream({ records: [] });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, SWALLOW);
    attachConnection(plugin);

    const got: string[] = [];
    await plugin.subscribe(SWALLOW, (m) => {
      got.push(m.content);
    });
    for (let seq = 1; seq <= 5; seq++) fake.state.records.push({ seq, data: payload(`m${seq}`) });
    await waitFor(() => got.length >= 5, 10000);
    await new Promise((r) => setTimeout(r, 1500));

    expect(got).toEqual(['m1', 'm2', 'm3', 'm4', 'm5']);
    expect(fake.state.created).toHaveLength(1);

    await plugin.disconnect();
  }, 20_000);
});

// Class 3: the live loop's resume position is only meaningful inside ONE incarnation of the store.
// A stream deleted and re-created out-of-band restarts its sequences at 1, so a position carried
// over from the incarnation before it names messages in the new one that were never sent — and the
// downward clamp that looks like it covers this only fires when the new incarnation happens to be
// SHORTER than the position carried over. Every row asserts that each message of the NEW
// incarnation reaches the handler exactly once, across both the rebuild causes the loop has and
// all three ways the new tail can sit against the position carried over.
describe('nats subscribe loop — a re-provisioned stream is resumed as a new store', () => {
  const record = (seq: number, tag: string): { seq: number; data: string } => ({
    seq,
    data: payload(`${tag}${seq}`),
  });

  const causes = [
    {
      name: 'a silent iterator EOF',
      carried: 5,
      seed: [1, 2, 3, 4, 5],
      arm: (fake: ReturnType<typeof fakeJetStream>): void => {
        fake.state.silentExits = 1;
      },
      afterSubscribe: (): void => undefined,
    },
    {
      name: 'a hole in the delivery sequence',
      carried: 2,
      seed: [],
      arm: (fake: ReturnType<typeof fakeJetStream>): void => {
        fake.state.swallowed = [3];
        fake.state.swallowGeneration = 1;
      },
      afterSubscribe: (fake: ReturnType<typeof fakeJetStream>): void => {
        for (let seq = 1; seq <= 5; seq++) fake.state.records.push(record(seq, 'o'));
      },
    },
  ];

  const tails = [
    { name: 'below the position carried over', of: (carried: number) => carried - 1 },
    { name: 'equal to the position carried over', of: (carried: number) => carried },
    { name: 'above the position carried over', of: (carried: number) => carried + 3 },
  ];

  for (const cause of causes) {
    for (const tail of tails) {
      it(`after ${cause.name}, a new incarnation whose tail is ${tail.name} is delivered whole`, async () => {
        const fresh = Array.from({ length: tail.of(cause.carried) }, (_, i) => record(i + 1, 'n'));
        const fake = fakeJetStream({
          records: cause.seed.map((seq) => record(seq, 'o')),
          swapCreatedOnInfoCall: 3, // the rebuild's own re-read of the stream
          swapCreatedTo: '2027-09-09T09:09:09.000000009Z',
          swapRecordsTo: () => fresh,
        });
        cause.arm(fake);
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, REBORN);
        attachConnection(plugin);

        const got: string[] = [];
        await plugin.subscribe(REBORN, (m) => {
          got.push(m.content);
        });
        cause.afterSubscribe(fake);

        const owed = fresh.map((_, i) => `n${i + 1}`);
        await waitFor(() => owed.every((c) => got.includes(c)), 15000);
        expect(got.filter((c) => c.startsWith('n'))).toEqual(owed);

        await plugin.disconnect();
      }, 25_000);
    }
  }

  // The other half of the same axis, and the one the re-provision rows above cannot reach: the
  // reported tail moves while `created` does NOT. Only a rebuild's position is at stake here — the
  // stream is the same store, so what it already delivered stays delivered, and a rebuild that lets
  // a stream-wide `last_seq` drag its position backwards replays messages the handler has seen
  // (core dedups them, but the loop is claiming a hole that does not exist).
  for (const tail of tails) {
    it(`a tail reported ${tail.name}, with the incarnation unchanged, redelivers nothing`, async () => {
      const fake = fakeJetStream({ records: [1, 2, 3, 4, 5].map((seq) => record(seq, 'o')) });
      const plugin = new NatsPlugin();
      injectFake(plugin, fake, REBORN);
      attachConnection(plugin);

      const got: string[] = [];
      await plugin.subscribe(REBORN, (m) => {
        got.push(m.content);
      });

      fake.state.visibleTail = tail.of(5);
      fake.state.swallowed = [6]; // a hole in delivery 1 — the loop rebuilds from lastSeq + 1
      fake.state.swallowGeneration = 1;
      for (const seq of [6, 7]) fake.state.records.push(record(seq, 'n'));

      await waitFor(() => got.includes('n7'), 15000);
      expect(got).toEqual(['n6', 'n7']);

      await plugin.disconnect();
    }, 25_000);
  }
});

describe('nats subscribe loop — every unplanned iterator exit rebuilds', () => {
  it('rebuilds after an iterator EOF that carried no consumer-loss event, resuming at lastSeq+1', async () => {
    const fake = fakeJetStream({ records: [], silentExits: 1 });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, SILENT);
    attachConnection(plugin);

    const got: string[] = [];
    await plugin.subscribe(SILENT, (m) => {
      got.push(m.content);
    });

    // Published while the subscriber has no live consumer: only a rebuild can deliver it.
    fake.state.records.push({ seq: 1, data: payload('during-gap') });
    await waitFor(() => got.includes('during-gap'), 10000);
    expect(fake.state.created.length).toBeGreaterThanOrEqual(2);

    await plugin.disconnect();
  });

  it('stops rebuilding once the connection is permanently closed', async () => {
    const fake = fakeJetStream({ records: [], silentExits: 100 });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, SILENT);
    attachConnection(plugin, true);

    await plugin.subscribe(SILENT, () => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    const after = fake.state.created.length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(fake.state.created.length).toBe(after);

    await plugin.disconnect();
  });

  it('a clean disconnect() ends the loop', async () => {
    const fake = fakeJetStream({ records: [] });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, SILENT);
    attachConnection(plugin);

    const got: string[] = [];
    await plugin.subscribe(SILENT, (m) => {
      got.push(m.content);
    });
    fake.state.records.push({ seq: 1, data: payload('live') });
    await waitFor(() => got.includes('live'), 5000);

    await plugin.disconnect();
    const created = fake.state.created.length;
    fake.state.records.push({ seq: 2, data: payload('after-teardown') });
    await new Promise((r) => setTimeout(r, 1500));
    expect(got).not.toContain('after-teardown');
    expect(fake.state.created.length).toBe(created);
  });
});
