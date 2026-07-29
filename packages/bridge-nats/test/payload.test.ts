import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { connect } from 'nats';
import { afterAll, describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { dropStreams, isNatsUp, rand, SERVERS, waitFor } from './helpers.js';

// Class: no byte sequence a publisher can put on the topic subject may throw out of fetchRecent or
// subscribe, and no field of a Message crossing the seam may be anything but a string. Anyone with
// publish rights on the subject can write these bytes, and a record that throws is unreadable
// forever — it kills every catch-up page covering that sequence. Generated payload space, not a
// fixed pair of cases, so variants nobody thought of are covered too.
const enc = new TextEncoder();

const rawPayloads: { name: string; bytes: Uint8Array }[] = [
  { name: 'json null', bytes: enc.encode('null') },
  { name: 'json array', bytes: enc.encode('[]') },
  { name: 'json string', bytes: enc.encode('"str"') },
  { name: 'json number', bytes: enc.encode('123') },
  { name: 'json true', bytes: enc.encode('true') },
  { name: 'empty object', bytes: enc.encode('{}') },
  { name: 'empty bytes', bytes: new Uint8Array(0) },
  { name: 'content is a number', bytes: enc.encode('{"content":123}') },
  { name: 'content is an object', bytes: enc.encode('{"content":{"a":1}}') },
  { name: 'content is null', bytes: enc.encode('{"content":null}') },
  { name: 'sender is an object', bytes: enc.encode('{"sender":{"x":1},"content":"hi"}') },
  { name: 'sender is an array', bytes: enc.encode('{"sender":[1,2],"content":"hi"}') },
  { name: 'ts is an object', bytes: enc.encode('{"content":"ok","ts":{"a":1}}') },
  { name: 'ts is a number', bytes: enc.encode('{"content":"ok","ts":1700000000}') },
  { name: 'truncated json', bytes: enc.encode('{"content":"trunc"') },
  { name: 'not json at all', bytes: enc.encode('<html>nope</html>') },
  { name: 'invalid utf-8', bytes: new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x80]) },
  { name: 'nul flood', bytes: new Uint8Array(200_000) },
  { name: 'prototype pollution attempt', bytes: enc.encode('{"__proto__":{"content":"x"}}') },
  { name: 'nested json string', bytes: enc.encode('"{\\"content\\":\\"quoted\\"}"') },
];

function assertAllStrings(m: Message): void {
  expect(typeof m.senderHandle).toBe('string');
  expect(typeof m.content).toBe('string');
  expect(typeof m.timestamp).toBe('string');
  expect(typeof m.backendMsgId).toBe('string');
  expect(typeof m.cursor).toBe('string');
  expect(Array.isArray(m.mentions)).toBe(true);
}

const suite = (await isNatsUp()) ? describe : describe.skip;

suite('nats untrusted payloads — hostile bytes must not break the seam', () => {
  const tag = rand();
  const cfg = { servers: SERVERS, subject_prefix: `px.${tag}.`, stream_prefix: `PX_${tag}_` };

  afterAll(async () => {
    await dropStreams(`PX_${tag}_`);
  });

  for (const { name, bytes } of rawPayloads) {
    it(`fetchRecent survives a record whose payload is ${name}`, async () => {
      const plugin = new NatsPlugin();
      await plugin.connect(cfg);
      const nc = await connect({ servers: SERVERS });
      try {
        const topic = asTopic(`raw-${rand()}`);
        await plugin.post(topic, asHandle('sys'), 'good-before');
        await nc.jetstream().publish(`px.${tag}.${topic}`, bytes);
        await plugin.post(topic, asHandle('sys'), 'good-after');

        const page = await plugin.fetchRecent({ topic });
        expect(page.messages).toHaveLength(3);
        for (const m of page.messages) assertAllStrings(m);
        // The poison record must not swallow its neighbours either.
        expect(page.messages[0].content).toBe('good-before');
        expect(page.messages[2].content).toBe('good-after');

        // Catch-up across the same record is equally fatal if it throws.
        const tail = await plugin.fetchRecent({ topic, since: page.messages[0].cursor });
        expect(tail.messages).toHaveLength(2);
        for (const m of tail.messages) assertAllStrings(m);
      } finally {
        await nc.drain();
        await plugin.disconnect();
      }
    });
  }

  it('subscribe delivers every hostile payload as a well-typed Message', async () => {
    const sub = new NatsPlugin();
    await sub.connect(cfg);
    const nc = await connect({ servers: SERVERS });
    try {
      const topic = asTopic(`rawlive-${rand()}`);
      const got: Message[] = [];
      let handlerThrew = false;
      await sub.subscribe(topic, (m) => {
        try {
          assertAllStrings(m);
        } catch {
          handlerThrew = true;
        }
        got.push(m);
      });
      await sub.post(topic, asHandle('sys'), 'warmup');
      await waitFor(() => got.length >= 1, 8000);

      const js = nc.jetstream();
      for (const { bytes } of rawPayloads) {
        await js.publish(`px.${tag}.${topic}`, bytes);
      }
      await waitFor(() => got.length >= rawPayloads.length + 1, 15000);
      expect(handlerThrew).toBe(false);
      for (const m of got) assertAllStrings(m);
    } finally {
      await nc.drain();
      await sub.disconnect();
    }
  });
});
