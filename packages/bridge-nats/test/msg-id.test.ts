import { asTopic, SeenSet, type BackendMsgId, type Message } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import {
  attachConnection,
  fakeJetStream,
  injectFake,
  payload,
  type FakeJetStream,
} from './fake-jetstream.js';
import { waitFor } from './helpers.js';

// Class: a backend store that was RE-PROVISIONED must not re-mint an id core has already seen.
// Every id here is a per-store counter (JetStream seq, and the same shape as a sqlite rowid or a
// postgres bigserial), and such a counter restarts at 1 in a fresh store — so the bare counter
// hands core a dedup key it already holds, and core's SeenSet drops a genuinely NEW message on the
// floor. The plugin engineers three separate recovery paths for a re-provisioned stream; a colliding
// id defeats all of them silently. `cursor` is deliberately NOT part of this class: it is the order
// key, opaque to core, and restarting it is what the catch-up fallback already handles.
const TOPIC = asTopic('reprovisioned');
const STREAM = 'PARLEY_reprovisioned';

const INCARNATIONS = ['2026-01-01T00:00:00.000000000Z', '2026-03-04T05:06:07.080910111Z'];

function withFake(): { plugin: NatsPlugin; fake: FakeJetStream } {
  const fake = fakeJetStream({ records: [], streamCreated: INCARNATIONS[0]! });
  const plugin = new NatsPlugin();
  injectFake(plugin, fake, STREAM);
  attachConnection(plugin);
  return { plugin, fake };
}

/** Wipe the fake's stream and hand back a NEW one under the same name, sequences restarting at 1. */
function reprovision(fake: FakeJetStream): void {
  fake.state.records = [];
  fake.state.streamCreated = INCARNATIONS[1]!;
  fake.state.publishMissing = 1;
}

const idMinters: {
  name: string;
  ids: (plugin: NatsPlugin, fake: FakeJetStream) => Promise<BackendMsgId[]>;
}[] = [
  {
    name: 'post',
    ids: async (plugin) => [
      await plugin.post(TOPIC, 'sys' as never, 'one'),
      await plugin.post(TOPIC, 'sys' as never, 'two'),
    ],
  },
  {
    name: 'fetchRecent',
    ids: async (plugin, fake) => {
      fake.state.records.push({ seq: 1, data: payload('one') }, { seq: 2, data: payload('two') });
      return (await plugin.fetchRecent({ topic: TOPIC })).messages.map((m) => m.backendMsgId);
    },
  },
  {
    name: 'subscribe',
    ids: async (plugin, fake) => {
      const live: Message[] = [];
      await plugin.subscribe(TOPIC, (m) => live.push(m));
      fake.state.records.push({ seq: 1, data: payload('one') }, { seq: 2, data: payload('two') });
      await waitFor(() => live.length >= 2, 10000);
      return live.slice(0, 2).map((m) => m.backendMsgId);
    },
  },
];

describe('nats backendMsgId survives a stream re-provisioned under it', () => {
  for (const minter of idMinters) {
    it(`${minter.name} mints ids disjoint from the previous incarnation's`, async () => {
      const { plugin, fake } = withFake();
      const before = await minter.ids(plugin, fake);
      expect(new Set(before).size).toBe(before.length);

      reprovision(fake);
      const after = await minter.ids(plugin, fake);

      expect(after).toHaveLength(before.length);
      expect(before.map(String).some((id) => after.map(String).includes(id))).toBe(false);

      // The consequence, stated in core's own terms: dedup must not swallow the new incarnation.
      const seen = new SeenSet();
      for (const id of before) seen.firstSeen(TOPIC, id);
      expect(after.map((id) => seen.firstSeen(TOPIC, id))).toEqual(after.map(() => true));

      await plugin.disconnect();
    }, 20_000);
  }

  it('keeps the cursor a bare sequence, and post/read agree on both values', async () => {
    const { plugin, fake } = withFake();
    const posted = await plugin.post(TOPIC, 'sys' as never, 'one');
    const [read] = (await plugin.fetchRecent({ topic: TOPIC })).messages;

    expect(read?.backendMsgId).toBe(posted);
    expect(read?.cursor).toBe('1');
    expect(String(posted)).not.toBe('1');
    expect(String(posted).endsWith('-1')).toBe(true);
    expect(fake.state.records).toHaveLength(1);

    await plugin.disconnect();
  });
});
