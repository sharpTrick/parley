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
const STREAM = 'PARLEY_silent';

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
        injectFake(plugin, fake, STREAM);
        attachConnection(plugin);

        const got: string[] = [];
        await plugin.subscribe(asTopic('swallow'), (m) => {
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
    injectFake(plugin, fake, STREAM);
    attachConnection(plugin);

    const got: string[] = [];
    await plugin.subscribe(asTopic('swallow'), (m) => {
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

describe('nats subscribe loop — every unplanned iterator exit rebuilds', () => {
  it('rebuilds after an iterator EOF that carried no consumer-loss event, resuming at lastSeq+1', async () => {
    const fake = fakeJetStream({ records: [], silentExits: 1 });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, STREAM);
    attachConnection(plugin);

    const got: string[] = [];
    await plugin.subscribe(asTopic('silent'), (m) => {
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
    injectFake(plugin, fake, STREAM);
    attachConnection(plugin, true);

    await plugin.subscribe(asTopic('silent'), () => undefined);
    await new Promise((r) => setTimeout(r, 1500));
    const after = fake.state.created.length;
    await new Promise((r) => setTimeout(r, 1500));
    expect(fake.state.created.length).toBe(after);

    await plugin.disconnect();
  });

  it('a clean disconnect() ends the loop', async () => {
    const fake = fakeJetStream({ records: [] });
    const plugin = new NatsPlugin();
    injectFake(plugin, fake, STREAM);
    attachConnection(plugin);

    const got: string[] = [];
    await plugin.subscribe(asTopic('silent'), (m) => {
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
