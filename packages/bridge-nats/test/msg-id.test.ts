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

// Class: a backend store that was RE-PROVISIONED must not re-mint an id core has already seen, for
// EVERY way the plugin can learn — or fail to learn — that it happened. Every id here is a per-store
// counter (JetStream seq, and the same shape as a sqlite rowid or a postgres bigserial), and such a
// counter restarts at 1 in a fresh store — so the bare counter hands core a dedup key it already
// holds, and core's SeenSet drops a genuinely NEW message on the floor. Both axes are crossed
// deliberately: an id minter that only qualifies its counter on the recovery path it happens to see
// (a 503, an info re-read) still collides when the store is replaced between two of its own calls.
// `cursor` is deliberately NOT part of this class: it is the order key, opaque to core, and
// restarting it is what the catch-up fallback already handles.
const TOPIC = asTopic('reprovisioned');
const STREAM = 'PARLEY_reprovisioned';

/**
 * Successive incarnation stamps differing ONLY in the sub-second part, so that a fold which keeps
 * the date and drops the precision collapses two incarnations into one id space and fails here.
 */
let stamped = 0;
const nextStamp = (): string => `2026-03-04T05:06:07.${String(++stamped).padStart(9, '0')}Z`;

function withFake(): { plugin: NatsPlugin; fake: FakeJetStream } {
  const fake = fakeJetStream({ records: [], streamCreated: nextStamp() });
  const plugin = new NatsPlugin();
  injectFake(plugin, fake, STREAM);
  attachConnection(plugin);
  return { plugin, fake };
}

/** Wipe the fake's stream and hand back a NEW one under the same name, sequences restarting at 1. */
function reprovision(fake: FakeJetStream): void {
  fake.state.records = [];
  fake.state.streamCreated = nextStamp();
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

/** What, if anything, tells the plugin the stream underneath it is a different one now. */
const observations: { name: string; observe: (plugin: NatsPlugin, fake: FakeJetStream) => Promise<void> }[] = [
  {
    name: 'a 503 on the next publish',
    observe: async (_plugin, fake) => {
      fake.state.publishMissing = 1;
    },
  },
  {
    name: 'an unrelated read re-reading streams.info',
    observe: async (plugin) => {
      await plugin.fetchRecent({ topic: TOPIC });
    },
  },
  { name: 'nothing at all — recreated between two of our calls', observe: async () => undefined },
];

describe('nats backendMsgId survives a stream re-provisioned under it', () => {
  for (const minter of idMinters) {
    for (const observation of observations) {
      it(`${minter.name} mints ids disjoint from the previous incarnation's, learning of it from ${observation.name}`, async () => {
        const { plugin, fake } = withFake();
        const before = await minter.ids(plugin, fake);
        expect(new Set(before).size).toBe(before.length);

        reprovision(fake);
        await observation.observe(plugin, fake);
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
  }

  // A `PubAck` carries a stream and a sequence but no incarnation, so the two halves of an id are
  // observed by two separate round trips. Between them the stream can be replaced — and then the
  // observed token labels a sequence it never owned, so the SURVIVING incarnation's own message at
  // that sequence mints an id core already holds and core drops a genuinely new message. The rows
  // above re-provision between whole calls; these re-provision inside `post` itself, and cross that
  // with what the surviving incarnation HOLDS at the acked sequence — a guard that only recognises
  // an empty sequence is blind to the incarnation that already refilled it, and one that rejects
  // whatever it is shown is no guard either, so `resolves` rows carry the floor.
  const ackAmbiguities: {
    name: string;
    outcome: 'rejects' | 'resolves';
    arm: (fake: FakeJetStream) => void;
  }[] = [
    {
      name: 'the surviving incarnation holds nothing at the acked sequence',
      outcome: 'rejects',
      arm: (fake) => {
        fake.state.swapCreatedOnInfoCall = fake.state.infoCalls + 1;
        fake.state.swapCreatedTo = nextStamp();
      },
    },
    {
      name: 'the surviving incarnation holds a DIFFERENT message at the acked sequence',
      outcome: 'rejects',
      arm: (fake) => {
        fake.state.swapCreatedOnInfoCall = fake.state.infoCalls + 1;
        fake.state.swapCreatedTo = nextStamp();
        fake.state.swapRecordsTo = (held) =>
          held.map((r) => ({ seq: r.seq, data: payload(`intruder${r.seq}`) }));
      },
    },
    {
      name: 'the surviving incarnation holds messages only BELOW the acked sequence',
      outcome: 'rejects',
      arm: (fake) => {
        fake.state.swapCreatedOnInfoCall = fake.state.infoCalls + 1;
        fake.state.swapCreatedTo = nextStamp();
        fake.state.swapRecordsTo = (held) =>
          held.slice(0, -1).map((r) => ({ seq: r.seq, data: payload(`intruder${r.seq}`) }));
      },
    },
    {
      name: 'the surviving incarnation holds exactly the message that was acked',
      outcome: 'resolves',
      arm: (fake) => {
        fake.state.swapCreatedOnInfoCall = fake.state.infoCalls + 1;
        fake.state.swapCreatedTo = nextStamp();
        fake.state.swapRecordsTo = (held) => held;
      },
    },
    {
      name: 'the read of the acked sequence itself reports nothing there',
      outcome: 'rejects',
      arm: (fake) => {
        reprovision(fake);
        fake.state.getMessageMissing = 1;
      },
    },
  ];

  /**
   * Every id this run minted, against the message it labelled. One id over two messages IS the
   * defect: core's SeenSet holds the first and drops the second as a duplicate.
   */
  const ledger = (): ((id: string, content: string) => void) => {
    const held = new Map<string, string>();
    return (id, content) => {
      expect(held.get(id) ?? content, `id ${id} labels both ${held.get(id)} and ${content}`).toBe(
        content,
      );
      held.set(id, content);
    };
  };

  for (const ambiguity of ackAmbiguities) {
    it(`post never labels a sequence with an incarnation it did not observe holding it, when ${ambiguity.name}`, async () => {
      const { plugin, fake } = withFake();
      const label = ledger();
      for (const content of ['one', 'two']) {
        label(String(await plugin.post(TOPIC, 'sys' as never, content)), content);
      }

      ambiguity.arm(fake);
      const outcome = await plugin
        .post(TOPIC, 'sys' as never, 'three')
        .then((id) => String(id), (err: unknown) => `rejected: ${String(err)}`);
      const rejected = outcome.startsWith('rejected: ');
      expect(rejected).toBe(ambiguity.outcome === 'rejects');
      if (rejected) expect(outcome).toMatch(/re-provisioned/);
      else label(outcome, 'three');

      // Whatever came back, the incarnation that SURVIVED now fills its own sequences — and no id
      // core reads out of it may be one `post` already handed back for a different message.
      fake.state.getMessageMissing = 0;
      fake.state.swapCreatedOnInfoCall = undefined;
      for (const content of ['four', 'five', 'six', 'seven']) {
        label(String(await plugin.post(TOPIC, 'sys' as never, content)), content);
      }
      for (const m of (await plugin.fetchRecent({ topic: TOPIC })).messages) {
        label(String(m.backendMsgId), m.content);
      }

      await plugin.disconnect();
    }, 20_000);
  }

  // The residual window the README states: the post-ack incarnation read is best-effort BY DESIGN —
  // failing it must not tell a caller to send a message that has already landed — so an id minted
  // while that read is failing carries the last incarnation the plugin observed, not the one on the
  // server. Pinned here so the README cannot drift back into denying it.
  it('an id minted while the incarnation read is failing carries the last observed incarnation', async () => {
    const { plugin, fake } = withFake();
    const observed = String(await plugin.post(TOPIC, 'sys' as never, 'one')).split('-')[0];

    fake.state.infoFailures = 1;
    const id = String(await plugin.post(TOPIC, 'sys' as never, 'two'));

    expect(id).toBe(`${observed ?? ''}-2`);
    expect(fake.state.infoFailures).toBe(0);

    await plugin.disconnect();
  });

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
