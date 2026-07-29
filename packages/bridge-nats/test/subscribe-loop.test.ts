import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake, payload } from './fake-jetstream.js';
import { waitFor } from './helpers.js';

// Class: the live loop must rebuild after EVERY unplanned end of the message iterator, not only
// after an explicit ConsumerDeleted/NotFound status event — a dropped link ends `consume()` with no
// event at all, and a loop that only rebuilds on the event goes silently deaf. Only `disconnect()`
// (or a permanently closed connection) may end it. The transport is faked because a healthy server
// will not produce a silent EOF on demand.
const STREAM = 'PARLEY_silent';

function attachConnection(plugin: NatsPlugin, closed = false): void {
  (plugin as unknown as { nc: unknown }).nc = {
    isClosed: () => closed,
    drain: async () => undefined,
    close: async () => undefined,
  };
}

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
