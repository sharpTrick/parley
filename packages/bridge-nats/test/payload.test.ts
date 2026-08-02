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

/** What a hostile record must degrade to: the VALUE of each seam field, not merely its type. */
interface Degraded {
  sender: string;
  content: string;
  ts: string;
}

const BLANK: Degraded = { sender: '', content: '', ts: '' };

/**
 * The wrongly-typed value shapes, crossed over each wire field below. `String(v)` is a string for
 * every one of them, so a `typeof` assertion cannot tell the hardening from its removal — only the
 * value can. Generated rather than listed, so a field added to the record later is covered by
 * construction instead of by someone remembering to write three more rows.
 */
const FIELD_VALUES: { name: string; json?: string; expected: string }[] = [
  { name: 'missing', expected: '' },
  { name: 'null', json: 'null', expected: '' },
  { name: 'a number', json: '42', expected: '' },
  { name: 'a boolean', json: 'true', expected: '' },
  { name: 'an array', json: '["drop","tables"]', expected: '' },
  { name: 'an object', json: '{"a":1}', expected: '' },
  { name: 'a nested object', json: '{"a":{"b":{"c":1}}}', expected: '' },
  { name: 'a string', json: '"real"', expected: 'real' },
];

const WIRE_FIELDS = ['sender', 'content', 'ts'] as const;

const generated: { name: string; bytes: Uint8Array; expected: Degraded }[] = WIRE_FIELDS.flatMap(
  (field) =>
    FIELD_VALUES.map((v) => ({
      name: `${field} is ${v.name}`,
      bytes: enc.encode(v.json === undefined ? '{}' : `{${JSON.stringify(field)}:${v.json}}`),
      expected: { ...BLANK, [field]: v.expected } as Degraded,
    })),
);

const rawPayloads: { name: string; bytes: Uint8Array; expected: Degraded }[] = [
  { name: 'json null', bytes: enc.encode('null'), expected: BLANK },
  { name: 'json array', bytes: enc.encode('[]'), expected: BLANK },
  { name: 'json string', bytes: enc.encode('"str"'), expected: BLANK },
  { name: 'json number', bytes: enc.encode('123'), expected: BLANK },
  { name: 'json true', bytes: enc.encode('true'), expected: BLANK },
  { name: 'empty object', bytes: enc.encode('{}'), expected: BLANK },
  { name: 'empty bytes', bytes: new Uint8Array(0), expected: BLANK },
  { name: 'content is a number', bytes: enc.encode('{"content":123}'), expected: BLANK },
  { name: 'content is an object', bytes: enc.encode('{"content":{"a":1}}'), expected: BLANK },
  { name: 'content is null', bytes: enc.encode('{"content":null}'), expected: BLANK },
  {
    name: 'sender is an object',
    bytes: enc.encode('{"sender":{"x":1},"content":"hi"}'),
    expected: { ...BLANK, content: 'hi' },
  },
  {
    name: 'sender is an array',
    bytes: enc.encode('{"sender":[1,2],"content":"hi"}'),
    expected: { ...BLANK, content: 'hi' },
  },
  {
    name: 'ts is an object',
    bytes: enc.encode('{"content":"ok","ts":{"a":1}}'),
    expected: { ...BLANK, content: 'ok' },
  },
  {
    name: 'ts is a number',
    bytes: enc.encode('{"content":"ok","ts":1700000000}'),
    expected: { ...BLANK, content: 'ok' },
  },
  { name: 'truncated json', bytes: enc.encode('{"content":"trunc"'), expected: BLANK },
  { name: 'not json at all', bytes: enc.encode('<html>nope</html>'), expected: BLANK },
  { name: 'invalid utf-8', bytes: new Uint8Array([0xff, 0xfe, 0xfd, 0x00, 0x80]), expected: BLANK },
  { name: 'nul flood', bytes: new Uint8Array(200_000), expected: BLANK },
  {
    name: 'prototype pollution attempt',
    bytes: enc.encode('{"__proto__":{"content":"x"}}'),
    expected: BLANK,
  },
  { name: 'nested json string', bytes: enc.encode('"{\\"content\\":\\"quoted\\"}"'), expected: BLANK },
  // A real string that merely LOOKS like a wrong type's stringification. It must survive intact, so
  // that blanking every field cannot masquerade as the degradation this file grades.
  {
    name: 'content is a string spelling [object Object]',
    bytes: enc.encode('{"content":"[object Object]"}'),
    expected: { ...BLANK, content: '[object Object]' },
  },
  ...generated,
];

function assertAllStrings(m: Message): void {
  expect(typeof m.senderHandle).toBe('string');
  expect(typeof m.content).toBe('string');
  expect(typeof m.timestamp).toBe('string');
  expect(typeof m.backendMsgId).toBe('string');
  expect(typeof m.cursor).toBe('string');
  expect(Array.isArray(m.mentions)).toBe(true);
}

/** The triple a record produced, for comparison against its documented degradation. */
const degradationOf = (m: Message): Degraded => ({
  sender: String(m.senderHandle),
  content: m.content,
  ts: m.timestamp,
});

/**
 * The floor stays — no field may be a non-string — but the VALUE is what carries the property.
 * `String(v)` satisfies every `typeof` check while handing the model `[object Object]` and
 * `drop,tables`, so a type assertion alone cannot see the hardening being removed.
 */
function assertDegradesTo(m: Message, expected: Degraded): void {
  assertAllStrings(m);
  expect(degradationOf(m)).toEqual(expected);
}

const suite = (await isNatsUp()) ? describe : describe.skip;

suite('nats untrusted payloads — hostile bytes must not break the seam', () => {
  const tag = rand();
  const cfg = { servers: SERVERS, subject_prefix: `px.${tag}.`, stream_prefix: `PX_${tag}_` };

  afterAll(async () => {
    await dropStreams(`PX_${tag}_`);
  });

  for (const { name, bytes, expected } of rawPayloads) {
    it(`fetchRecent degrades a record whose payload is ${name}`, async () => {
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
        assertDegradesTo(page.messages[1]!, expected);
        // The poison record must not swallow its neighbours either.
        expect(page.messages[0]!.content).toBe('good-before');
        expect(page.messages[2]!.content).toBe('good-after');

        // Catch-up across the same record is equally fatal if it throws.
        const tail = await plugin.fetchRecent({ topic, since: page.messages[0]!.cursor });
        expect(tail.messages).toHaveLength(2);
        for (const m of tail.messages) assertAllStrings(m);
        assertDegradesTo(tail.messages[0]!, expected);
      } finally {
        await nc.drain();
        await plugin.disconnect();
      }
    });
  }

  it('subscribe delivers every hostile payload degraded to its documented value', async () => {
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

      // Compared as a multiset, so the property does not rest on delivery order. `String(v)` would
      // put `[object Object]` and `drop,tables` in here, which no expected triple holds.
      const key = (d: Degraded): string => JSON.stringify(d);
      const warmup = got.find((m) => m.content === 'warmup');
      expect(warmup).toBeDefined();
      const hostile = got.filter((m) => m !== warmup).map((m) => key(degradationOf(m)));
      expect(hostile.sort()).toEqual(rawPayloads.map((p) => key(p.expected)).sort());
    } finally {
      await nc.drain();
      await sub.disconnect();
    }
  });
});
