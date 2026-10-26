import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { dropStreams, isNatsUp, rand, seqOf, SERVERS } from './helpers.js';

// Class: a `backend_config` value that must match across the configs sharing one cluster either
// diverges HARMLESSLY, or fails with an error naming the field the operator can change. The one
// thing it may not do is what the docs used to promise — split history quietly — because an operator
// following that description hunts for two halves of a conversation instead of a broken bridge.
// Only the real server decides which of the four prefix combinations is which: on a fake, "both
// prefixes differ" and "neither differs" both just create a stream. Parameterised over the divergent
// fields, so a fifth prefix-shaped field added later joins the table rather than needing a new test.
// Every test here is server-gated, and the file holds nothing else.

const suite = (await isNatsUp()) ? describe : describe.skip;

suite('nats prefix divergence across two configs on one cluster', () => {
  const tag = rand();
  const prefixes = [`PX_${tag}_`, `PY_${tag}_`];

  afterAll(async () => {
    for (const prefix of prefixes) await dropStreams(prefix);
  });

  const divergences: {
    subject: boolean;
    stream: boolean;
    /** `undefined` = the second instance works; a pattern = it must reject, naming these fields. */
    names?: RegExp;
    shares: boolean;
  }[] = [
    { subject: false, stream: false, shares: true },
    { subject: true, stream: false, names: /subject_prefix|stream_prefix/, shares: false },
    { subject: false, stream: true, names: /stream_prefix/, shares: false },
    { subject: true, stream: true, shares: false },
  ];

  for (const divergence of divergences) {
    const diverging = [
      ...(divergence.subject ? ['subject_prefix'] : []),
      ...(divergence.stream ? ['stream_prefix'] : []),
    ];
    const label = diverging.length === 0 ? 'nothing diverges' : `${diverging.join(' and ')} diverge(s)`;

    it(`${label}: the second instance ${divergence.names === undefined ? 'runs' : 'refuses, naming the field'}`, async () => {
      const topic = asTopic(`div-${rand()}`);
      const a = new NatsPlugin();
      const b = new NatsPlugin();
      await a.connect({ servers: SERVERS, subject_prefix: `px.${tag}.`, stream_prefix: prefixes[0] });
      await b.connect({
        servers: SERVERS,
        subject_prefix: divergence.subject ? `py.${tag}.` : `px.${tag}.`,
        stream_prefix: divergence.stream ? prefixes[1] : prefixes[0],
      });
      try {
        await a.post(topic, asHandle('sys'), 'from-a');

        const posted = await b
          .post(topic, asHandle('sys'), 'from-b')
          .then(() => undefined, (e: unknown) => String(e));

        if (divergence.names !== undefined) {
          expect(posted).toMatch(divergence.names);
          const read = await b.fetchRecent({ topic }).then(() => undefined, (e: unknown) => String(e));
          expect(read).toMatch(divergence.names);
          return;
        }

        expect(posted).toBeUndefined();
        const seen = (await b.fetchRecent({ topic })).messages.map((m) => m.content);
        expect(seen).toEqual(divergence.shares ? ['from-a', 'from-b'] : ['from-b']);
      } finally {
        await a.disconnect();
        await b.disconnect();
      }
    }, 60_000);
  }

  // The severe half of the read defect, against a stream the server itself made sparse: a window
  // sized down from `last_seq` can hold no message, and the cursor of that empty page sits above
  // every message it failed to return — so core's cold start adopts it and the history is gone.
  it('a since-less page returns the newest messages when the top sequences are deleted', async () => {
    const plugin = new NatsPlugin();
    await plugin.connect({ servers: SERVERS, subject_prefix: `px.${tag}.`, stream_prefix: prefixes[0] });
    const topic = asTopic(`sparse-${rand()}`);
    try {
      const contents = Array.from({ length: 12 }, (_, i) => `m${i + 1}`);
      for (const c of contents) await plugin.post(topic, asHandle('sys'), c);

      const jsm = (plugin as unknown as { jsm: { streams: { deleteMessage: (s: string, seq: number) => Promise<boolean> } } }).jsm;
      for (let seq = 5; seq <= 12; seq++) await jsm.streams.deleteMessage(`${prefixes[0]}${topic}`, seq);

      for (const limit of [1, 2, 100]) {
        const page = await plugin.fetchRecent({ topic, limit });
        expect(page.messages.map((m) => m.content)).toEqual(contents.slice(0, 4).slice(-limit));
        expect(seqOf(page.nextCursor)).toBe(4);
      }
    } finally {
      await plugin.disconnect();
    }
  }, 60_000);
});
