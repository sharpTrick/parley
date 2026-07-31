/**
 * The JetStream semantics `fake-jetstream.ts` models, each stated once as a row that runs against
 * BOTH the fake and a real server. `window.test.ts` runs the fake side (no server needed) and
 * `jetstream-agreement-live.test.ts` runs the live side; both grade the same `expected` literal, so
 * a fake that answers a call the way the server does not is a red test rather than a suite-wide
 * false green.
 *
 * `covers` names the fake primitives a row exercises, and the coverage assertion in `window.test.ts`
 * requires the union to be every primitive the fake models — so a primitive added to the fake later
 * arrives with no agreement row and fails by default.
 *
 * A row over a fault the fake INJECTS (a removed stream, a name already in use) grades the shape of
 * the outcome the plugin's classifiers see, not the server's decision to produce it; a row over a
 * semantic the fake computes (`last_by_subj`, `opt_start_seq`) grades the semantic itself.
 */
import { connect, type NatsConnection } from 'nats';
import { fakeJetStream, payload } from './fake-jetstream.js';

const enc = new TextEncoder();
const delay = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** How a caller classifies a failed call, spelled out here so a row cannot inherit the plugin's own mistake. */
export type Outcome = 'not-found' | 'stream-missing' | 'name-in-use' | 'ok';

const classify = (err: unknown): Outcome => {
  const msg = err instanceof Error ? err.message : String(err);
  if (/already in use|already exists|name already/i.test(msg)) return 'name-in-use';
  if (/stream not found|no responders|503/i.test(msg)) return 'stream-missing';
  if (/no message found|message not found|no stream matches|404/i.test(msg)) return 'not-found';
  throw err;
};

const attempt = async <T>(run: () => Promise<T>): Promise<T | Outcome> =>
  run().catch((err: unknown) => classify(err));

/** The JetStream operations an agreement row may use, in the terms both backings can answer. */
export interface Arena {
  publish: (token: string, content: string) => Promise<number>;
  deleteMessage: (seq: number) => Promise<void>;
  purge: (token: string) => Promise<void>;
  lastBySubject: (token: string) => Promise<number | Outcome>;
  getSeq: (seq: number) => Promise<number | Outcome>;
  counters: () => Promise<{ messages: number; first_seq: number; last_seq: number }>;
  pull: (token: string, startSeq: number, max: number) => Promise<number[]>;
  consume: (token: string, startSeq: number, want: number) => Promise<{ seq: number; delivery: number }[]>;
  findStream: (token: string) => Promise<'the stream' | Outcome>;
  addAgain: (tokens: string[]) => Promise<'created' | Outcome>;
  removeStreamThenPublish: (token: string) => Promise<'created' | Outcome>;
  close: () => Promise<void>;
}

const PRIMITIVES = [
  'jsm.streams.add',
  'jsm.streams.find',
  'jsm.streams.info',
  'jsm.streams.getMessage',
  'jsm.consumers.add',
  'jsm.consumers.delete',
  'js.consumers.get',
  'js.publish',
  'consumer.fetch',
  'consumer.consume',
] as const;

export type Primitive = (typeof PRIMITIVES)[number];

/** Every JetStream call the fake actually models, read off the fake rather than listed. */
export function fakePrimitives(): string[] {
  const { js, jsm } = fakeJetStream() as unknown as {
    js: { consumers: Record<string, unknown>; [k: string]: unknown };
    jsm: { streams: Record<string, unknown>; consumers: Record<string, unknown> };
  };
  const consumer = ['fetch', 'consume'].map((k) => `consumer.${k}`);
  return [
    ...Object.keys(jsm.streams).map((k) => `jsm.streams.${k}`),
    ...Object.keys(jsm.consumers).map((k) => `jsm.consumers.${k}`),
    ...Object.keys(js.consumers).map((k) => `js.consumers.${k}`),
    ...Object.keys(js).filter((k) => k !== 'consumers').map((k) => `js.${k}`),
    ...consumer,
  ].sort();
}

export interface AgreementRow {
  name: string;
  covers: Primitive[];
  expected: unknown;
  run: (arena: Arena) => Promise<unknown>;
}

export const AGREEMENT_ROWS: AgreementRow[] = [
  {
    name: 'last_by_subj names the surviving message when the subject’s newest is deleted',
    covers: ['js.publish', 'jsm.streams.getMessage'],
    expected: 1,
    run: async (a) => {
      await a.publish('a', 'a1');
      const second = await a.publish('a', 'a2');
      await a.publish('b', 'b1');
      await a.deleteMessage(second);
      return a.lastBySubject('a');
    },
  },
  {
    name: 'last_by_subj names the survivor when the STREAM tail is the deleted message',
    covers: ['js.publish', 'jsm.streams.getMessage', 'jsm.streams.info'],
    expected: { last: 1, counters: { messages: 1, first_seq: 1, last_seq: 2 } },
    run: async (a) => {
      await a.publish('a', 'a1');
      await a.deleteMessage(await a.publish('a', 'a2'));
      return { last: await a.lastBySubject('a'), counters: await a.counters() };
    },
  },
  {
    name: 'last_by_subj on a subject that never had a message is not found',
    covers: ['js.publish', 'jsm.streams.getMessage'],
    expected: 'not-found',
    run: async (a) => {
      await a.publish('other', 'o1');
      return a.lastBySubject('mine');
    },
  },
  {
    name: 'last_by_subj after the subject is purged is not found',
    covers: ['js.publish', 'jsm.streams.getMessage'],
    expected: 'not-found',
    run: async (a) => {
      await a.publish('a', 'a1');
      await a.publish('b', 'b1');
      await a.purge('a');
      return a.lastBySubject('a');
    },
  },
  {
    name: 'getMessage on a deleted sequence is not found',
    covers: ['js.publish', 'jsm.streams.getMessage'],
    expected: 'not-found',
    run: async (a) => {
      const seq = await a.publish('a', 'a1');
      await a.deleteMessage(seq);
      return a.getSeq(seq);
    },
  },
  {
    name: 'a pull below first_seq starts at the first surviving sequence instead of stalling',
    covers: ['jsm.consumers.add', 'js.consumers.get', 'consumer.fetch', 'jsm.consumers.delete'],
    expected: [4, 5],
    run: async (a) => {
      for (let i = 1; i <= 5; i++) await a.publish('a', `m${i}`);
      for (const seq of [1, 2, 3]) await a.deleteMessage(seq);
      return a.pull('a', 1, 5);
    },
  },
  {
    name: 'a pull sees only its filter_subject, from its opt_start_seq',
    covers: ['jsm.consumers.add', 'js.consumers.get', 'consumer.fetch', 'jsm.consumers.delete'],
    expected: [3, 5],
    run: async (a) => {
      await a.publish('a', 'a1');
      await a.publish('b', 'b1');
      await a.publish('a', 'a2');
      await a.publish('b', 'b2');
      await a.publish('a', 'a3');
      return a.pull('a', 3, 10);
    },
  },
  {
    name: 'consume counts deliveries from 1 and yields in sequence order',
    covers: ['jsm.consumers.add', 'js.consumers.get', 'consumer.consume', 'jsm.consumers.delete'],
    expected: [
      { seq: 1, delivery: 1 },
      { seq: 3, delivery: 2 },
    ],
    run: async (a) => {
      await a.publish('a', 'a1');
      await a.publish('b', 'b1');
      await a.publish('a', 'a2');
      return a.consume('a', 1, 2);
    },
  },
  {
    name: 'streams.find names the stream capturing a subject',
    covers: ['jsm.streams.find', 'js.publish'],
    expected: 'the stream',
    run: async (a) => {
      await a.publish('a', 'a1');
      return a.findStream('a');
    },
  },
  {
    name: 'streams.find on a subject no stream captures is not found',
    covers: ['jsm.streams.find'],
    expected: 'not-found',
    run: async (a) => a.findStream('__uncaptured__'),
  },
  {
    name: 'streams.add on a name already held with other subjects is refused',
    covers: ['jsm.streams.add'],
    expected: 'name-in-use',
    run: async (a) => a.addAgain(['__elsewhere__']),
  },
  {
    name: 'a publish to a stream removed out-of-band reports the stream missing',
    covers: ['jsm.streams.add', 'js.publish'],
    expected: 'stream-missing',
    run: async (a) => a.removeStreamThenPublish('a'),
  },
];

/** The fake, driven through the same operations — its `state` IS the server it models. */
export function fakeArena(): Arena {
  const STREAM = 'FAKE_STREAM';
  const PREFIX = 'jf.';
  const fake = fakeJetStream({ subject: `${PREFIX}a`, subjects: [`${PREFIX}>`] });
  const state = fake.state;
  const jsm = fake.jsm as {
    streams: {
      add: (cfg: unknown) => Promise<unknown>;
      find: (subject: string) => Promise<string>;
      info: () => Promise<{ state: { messages: number; first_seq: number; last_seq: number } }>;
      getMessage: (s: string, r: { seq?: number; last_by_subj?: string }) => Promise<{ seq: number }>;
    };
    consumers: {
      add: (s: string, c: unknown) => Promise<{ name: string }>;
      delete: (s: string, n: string) => Promise<boolean>;
    };
  };
  const js = fake.js as {
    publish: (subject: string, data: Uint8Array) => Promise<{ seq: number }>;
    consumers: { get: () => Promise<{
      fetch: (o: { max_messages: number }) => Promise<AsyncIterable<{ seq: number }> & { close: () => void }>;
      consume: () => Promise<
        AsyncIterable<{ seq: number; info: { deliverySequence: number } }> & { close: () => Promise<void> }
      >;
    }> };
  };
  const subject = (token: string): string => `${PREFIX}${token}`;
  /** A delete leaves `last_seq` where it was, which is what `visibleTail` reports. */
  const spend = (): void => {
    state.visibleTail = Math.max(state.visibleTail ?? 0, state.records.at(-1)?.seq ?? 0);
  };
  const addConsumer = async (token: string, startSeq: number): Promise<string> =>
    (await jsm.consumers.add(STREAM, { filter_subject: subject(token), opt_start_seq: startSeq })).name;

  return {
    publish: async (token, content) => (await js.publish(subject(token), enc.encode(payload(content)))).seq,
    deleteMessage: async (seq) => {
      spend();
      state.records = state.records.filter((r) => r.seq !== seq);
    },
    purge: async (token) => {
      spend();
      state.records = state.records.filter((r) => (r.subject ?? state.subject) !== subject(token));
    },
    lastBySubject: async (token) =>
      attempt(async () => (await jsm.streams.getMessage(STREAM, { last_by_subj: subject(token) })).seq),
    getSeq: async (seq) => attempt(async () => (await jsm.streams.getMessage(STREAM, { seq })).seq),
    counters: async () => {
      const { messages, first_seq, last_seq } = (await jsm.streams.info()).state;
      return { messages, first_seq, last_seq };
    },
    pull: async (token, startSeq, max) => {
      const name = await addConsumer(token, startSeq);
      const seen: number[] = [];
      for await (const m of await (await js.consumers.get()).fetch({ max_messages: max })) seen.push(m.seq);
      await jsm.consumers.delete(STREAM, name);
      return seen;
    },
    consume: async (token, startSeq, want) => {
      const name = await addConsumer(token, startSeq);
      const iter = await (await js.consumers.get()).consume();
      const seen: { seq: number; delivery: number }[] = [];
      const drained = (async () => {
        for await (const m of iter) {
          seen.push({ seq: m.seq, delivery: m.info.deliverySequence });
          if (seen.length >= want) void iter.close();
        }
      })();
      await Promise.race([drained, delay(5000)]);
      await iter.close();
      await drained.catch(() => undefined);
      await jsm.consumers.delete(STREAM, name);
      return seen;
    },
    findStream: async (token) => {
      state.rivalStream = token === '__uncaptured__' ? undefined : STREAM;
      return attempt(async () => {
        await jsm.streams.find(subject(token));
        return 'the stream' as const;
      });
    },
    addAgain: async () => {
      state.addFails = 'name-in-use';
      return attempt(async () => {
        await jsm.streams.add({ name: STREAM });
        return 'created' as const;
      });
    },
    removeStreamThenPublish: async (token) => {
      state.streamAbsent = true;
      state.publishMissing = 1;
      return attempt(async () => {
        await js.publish(subject(token), enc.encode(payload('x')));
        return 'created' as const;
      });
    },
    close: async () => undefined,
  };
}

/** The same operations against a real JetStream server, on a stream of this arena's own. */
export async function liveArena(servers: string, tag: string): Promise<Arena> {
  const nc: NatsConnection = await connect({ servers });
  const jsm = await nc.jetstreamManager();
  const js = nc.jetstream();
  const stream = `JF_${tag}`;
  const prefix = `jf.${tag.toLowerCase()}.`;
  const subject = (token: string): string => `${prefix}${token}`;
  await jsm.streams.add({ name: stream, subjects: [`${prefix}>`] });
  const addConsumer = async (token: string, startSeq: number): Promise<string> =>
    (
      await jsm.consumers.add(stream, {
        filter_subject: subject(token),
        deliver_policy: 'by_start_sequence' as never,
        opt_start_seq: startSeq,
        ack_policy: 'none' as never,
        inactive_threshold: 30_000_000_000,
      })
    ).name;

  return {
    publish: async (token, content) => (await js.publish(subject(token), enc.encode(payload(content)))).seq,
    deleteMessage: async (seq) => {
      await jsm.streams.deleteMessage(stream, seq);
    },
    purge: async (token) => {
      await jsm.streams.purge(stream, { filter: subject(token) });
    },
    lastBySubject: async (token) =>
      attempt(async () => (await jsm.streams.getMessage(stream, { last_by_subj: subject(token) })).seq),
    getSeq: async (seq) => attempt(async () => (await jsm.streams.getMessage(stream, { seq })).seq),
    counters: async () => {
      const { state } = await jsm.streams.info(stream);
      return { messages: state.messages, first_seq: state.first_seq, last_seq: state.last_seq };
    },
    pull: async (token, startSeq, max) => {
      const name = await addConsumer(token, startSeq);
      const consumer = await js.consumers.get(stream, name);
      const seen: number[] = [];
      const batch = await consumer.fetch({ max_messages: max, expires: 2000 });
      for await (const m of batch) {
        seen.push(m.seq);
        if (seen.length >= max) break;
      }
      await jsm.consumers.delete(stream, name);
      return seen;
    },
    consume: async (token, startSeq, want) => {
      const name = await addConsumer(token, startSeq);
      const consumer = await js.consumers.get(stream, name);
      const iter = await consumer.consume();
      const seen: { seq: number; delivery: number }[] = [];
      const drained = (async () => {
        for await (const m of iter) {
          seen.push({ seq: m.seq, delivery: m.info.deliverySequence });
          if (seen.length >= want) void iter.close();
        }
      })();
      await Promise.race([drained, delay(5000)]);
      await iter.close();
      await drained.catch(() => undefined);
      await jsm.consumers.delete(stream, name).catch(() => undefined);
      return seen;
    },
    findStream: async (token) =>
      attempt(async () => {
        await jsm.streams.find(token === '__uncaptured__' ? 'nothing.captures.this' : subject(token));
        return 'the stream' as const;
      }),
    addAgain: async (tokens) =>
      attempt(async () => {
        await jsm.streams.add({ name: stream, subjects: tokens.map((t) => `${prefix}${t}`) });
        return 'created' as const;
      }),
    removeStreamThenPublish: async (token) => {
      await jsm.streams.delete(stream);
      return attempt(async () => {
        await js.publish(subject(token), enc.encode(payload('x')));
        return 'created' as const;
      });
    },
    close: async () => {
      await jsm.streams.delete(stream).catch(() => undefined);
      await nc.close();
    },
  };
}

export { PRIMITIVES };
