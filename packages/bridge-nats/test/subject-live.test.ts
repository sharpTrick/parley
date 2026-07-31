import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { connect } from 'nats';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { dropStreams, isNatsUp, rand, SERVERS, waitFor } from './helpers.js';

// Class: the topic allowlist is enforced by the CONSUMER's `filter_subject`, and only a real server
// can grade it. `ensureStream` deliberately accepts a pre-existing stream whose subject list is
// wider than this topic (config.test.ts certifies a `<prefix>>` stream as covering it), so on such a
// stream every other publisher on the cluster is one dropped filter away from reaching agent context
// — which is exactly what CLAUDE.md's "inbound is untrusted / respect the topic allowlist" forbids.
// A fake cannot stand in here: it is the server that decides what a consumer with no filter sees.
// Crossed over every read path, because each builds its own consumer and can forget separately, and
// over the sibling's POSITION, because a foreign message below the topic's own tail is excluded by
// the window arithmetic even when the filter is gone.
// Every test here is server-gated, and the file holds nothing else.

const suite = (await isNatsUp()) ? describe : describe.skip;

suite('nats reads see their own subject only, on a stream wider than the topic', () => {
  const tag = rand();
  const enc = new TextEncoder();

  afterAll(async () => {
    await dropStreams(`PS_${tag}_`);
  });

  interface Arena {
    cfg: { servers: string; subject_prefix: string; stream_prefix: string };
    topic: string;
    subject: (of: Neighbour) => string;
    publish: (subject: string, content: string) => Promise<void>;
    done: () => Promise<void>;
  }

  /**
   * One topic on a stream capturing its whole prefix — the shape `ensureStream` accepts and shares.
   * Each arena takes its own prefix, so the wildcard streams cannot overlap one another.
   */
  const arena = async (): Promise<Arena> => {
    const local = rand();
    const subjectPrefix = `ps.${tag}.${local}.`;
    const topic = `shared${local}`;
    const nc = await connect({ servers: SERVERS });
    const jsm = await nc.jetstreamManager();
    const js = nc.jetstream();
    await jsm.streams.add({ name: `PS_${tag}_${local}_${topic}`, subjects: [`${subjectPrefix}>`] });
    return {
      cfg: { servers: SERVERS, subject_prefix: subjectPrefix, stream_prefix: `PS_${tag}_${local}_` },
      topic,
      subject: (of) => of.suffix(subjectPrefix, topic),
      publish: async (subject, content) => {
        await js.publish(subject, enc.encode(
          JSON.stringify({ sender: 'outsider', content, ts: new Date().toISOString(), in_reply_to: '' }),
        ));
      },
      done: async () => {
        await nc.drain();
      },
    };
  };

  interface Neighbour {
    name: string;
    suffix: (prefix: string, topic: string) => string;
  }

  const neighbours: Neighbour[] = [
    { name: 'a sibling subject', suffix: (p, t) => `${p}not-${t}` },
    { name: 'a deeper subject under the topic', suffix: (p, t) => `${p}${t}.deeper` },
    { name: 'the topic subject itself', suffix: (p, t) => `${p}${t}` },
  ];

  for (const neighbour of neighbours) {
    // The exact-subject row is the floor: an outside publisher on the topic's OWN subject IS the
    // topic, so a read that answers "nothing" to everything passes the other two rows and fails here.
    const mine = neighbour.name === 'the topic subject itself';

    it(`catch-up ${mine ? 'returns' : 'never returns'} ${neighbour.name}`, async () => {
      const at = await arena();
      const topic = asTopic(at.topic);
      const plugin = new NatsPlugin();
      await plugin.connect(at.cfg);
      try {
        await plugin.post(topic, asHandle('sys'), 'own-1');
        await at.publish(at.subject(neighbour), 'outsider-1');
        await plugin.post(topic, asHandle('sys'), 'own-2');
        await at.publish(at.subject(neighbour), 'outsider-2');

        const page = await plugin.fetchRecent({ topic });
        const fromStart = await plugin.fetchRecent({ topic, since: page.messages[0]?.cursor });

        const owed = mine ? ['own-1', 'outsider-1', 'own-2', 'outsider-2'] : ['own-1', 'own-2'];
        expect(page.messages.map((m) => m.content)).toEqual(owed);
        expect(fromStart.messages.map((m) => m.content)).toEqual(owed.slice(1));
      } finally {
        await plugin.disconnect();
        await at.done();
      }
    }, 60_000);

    it(`a long-poll ${mine ? 'wakes on' : 'is not woken by'} ${neighbour.name}`, async () => {
      const at = await arena();
      const topic = asTopic(at.topic);
      const plugin = new NatsPlugin();
      await plugin.connect(at.cfg);
      try {
        await plugin.post(topic, asHandle('sys'), 'own-1');
        const tail = (await plugin.fetchRecent({ topic })).nextCursor;

        const polled = plugin.fetchRecent({ topic, since: tail, blockMs: 3000 });
        await new Promise((r) => setTimeout(r, 300));
        await at.publish(at.subject(neighbour), 'outsider-1');

        expect((await polled).messages.map((m) => m.content)).toEqual(mine ? ['outsider-1'] : []);
      } finally {
        await plugin.disconnect();
        await at.done();
      }
    }, 60_000);

    it(`subscribe ${mine ? 'delivers' : 'never delivers'} ${neighbour.name}`, async () => {
      const at = await arena();
      const topic = asTopic(at.topic);
      const plugin = new NatsPlugin();
      await plugin.connect(at.cfg);
      try {
        const seen: Message[] = [];
        await plugin.subscribe(topic, (m) => seen.push(m));
        await new Promise((r) => setTimeout(r, 500));

        await at.publish(at.subject(neighbour), 'outsider-1');
        await plugin.post(topic, asHandle('sys'), 'own-1');

        await waitFor(() => seen.some((m) => m.content === 'own-1'), 15_000);
        expect(seen.map((m) => m.content)).toEqual(mine ? ['outsider-1', 'own-1'] : ['own-1']);
      } finally {
        await plugin.disconnect();
        await at.done();
      }
    }, 60_000);
  }

  // The same arena read for its BUDGET rather than its contents. A topic with no message of its own
  // is the shape where every stream-wide counter says there is a window to read and the filtered
  // pull answers with nothing — so `block_ms` is kept only if an empty PAGE waits, not merely an
  // empty predicted window. The rows above cannot see it: each posts before it polls.
  it('a long-poll on a topic with nothing of its own waits its budget, and wakes on its first message', async () => {
    const at = await arena();
    const topic = asTopic(at.topic);
    const plugin = new NatsPlugin();
    await plugin.connect(at.cfg);
    try {
      await at.publish(at.subject(neighbours[0] as Neighbour), 'outsider-1');

      const started = Date.now();
      const empty = await plugin.fetchRecent({ topic, blockMs: 2000 });
      const waited = Date.now() - started;
      expect(empty.messages).toEqual([]);
      expect(waited).toBeGreaterThanOrEqual(1500);
      expect(waited).toBeLessThan(4000);

      const polled = plugin.fetchRecent({ topic, blockMs: 10_000 });
      await new Promise((r) => setTimeout(r, 300));
      await plugin.post(topic, asHandle('sys'), 'own-1');

      expect((await polled).messages.map((m) => m.content)).toEqual(['own-1']);
    } finally {
      await plugin.disconnect();
      await at.done();
    }
  }, 60_000);
});
