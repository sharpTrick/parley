import { asCursor, asTopic, type Cursor } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake, payload, type FakeJetStream } from './fake-jetstream.js';

// Class 1: the backend store was RE-PROVISIONED under a persisted cursor. Every message the new
// incarnation holds is one that cursor's reader has never seen, so draining from it yields ALL of
// them, in order — never parked on a sequence the new stream will not reach, and never resumed at
// the new stream's tail. Two axes decide this, and a table missing either certifies a rule rather
// than the property: the new incarnation's LENGTH relative to the persisted sequence (a cursor ABOVE
// the new tail is the easy half — one that has grown past it reads as a live position), and its
// length relative to the page `limit` (a newest-window fallback is indistinguishable from a complete
// read whenever one page covers the whole incarnation).
// Class 2: `since` is caller input (`parley_fetch_recent` declares it as a plain string), so a
// value this plugin could not have minted must fail loudly. It may never become a permanently
// empty page whose `nextCursor` echoes the junk back while the stream demonstrably has messages.
const TOPIC = asTopic('cursors');
const ALL = ['a', 'b', 'c'];

function withRecords(contents: string[]): { plugin: NatsPlugin; fake: FakeJetStream } {
  const fake = fakeJetStream({ records: contents.map((c, i) => ({ seq: i + 1, data: payload(c) })) });
  const plugin = new NatsPlugin();
  injectFake(plugin, fake, TOPIC);
  return { plugin, fake };
}

/** Everything a reader still sees when it resumes from `cursor` and keeps following nextCursor. */
async function drainFrom(plugin: NatsPlugin, cursor: Cursor, limit?: number): Promise<string[]> {
  const seen: string[] = [];
  let since = cursor;
  for (let i = 0; i < 200; i++) {
    const page = await plugin.fetchRecent({ topic: TOPIC, since, ...(limit === undefined ? {} : { limit }) });
    if (page.messages.length === 0) break;
    seen.push(...page.messages.map((m) => m.content));
    since = page.nextCursor;
  }
  return seen;
}

const staleCursors = ['4', '9', '1000', '9007199254740991'];
const reads: { name: string; extra: { blockMs?: number; limit?: number } }[] = [
  { name: 'plain catch-up', extra: {} },
  { name: 'long-poll catch-up', extra: { blockMs: 1000 } },
  { name: 'small-limit catch-up', extra: { limit: 1 } },
];

describe('nats catch-up survives a stream re-provisioned under the cursor', () => {
  for (const stale of staleCursors) {
    for (const read of reads) {
      it(`${read.name} from stale cursor ${stale} still sees the recreated stream`, async () => {
        const { plugin, fake } = withRecords(ALL);

        const page = await plugin.fetchRecent({
          topic: TOPIC,
          since: asCursor(stale),
          ...read.extra,
        });

        expect(page.messages.length).toBeGreaterThan(0);
        expect(page.nextCursor).not.toBe(stale);
        const seen = [
          ...page.messages.map((m) => m.content),
          ...(await drainFrom(plugin, page.nextCursor, read.extra.limit)),
        ];
        expect(seen).toEqual(ALL);

        fake.state.records.push({ seq: ALL.length + 1, data: payload('later') });
        expect(await drainFrom(plugin, page.nextCursor)).toContain('later');
      });
    }
  }

  it('an EMPTY recreated stream does not strand the cursor above its tail', async () => {
    const { plugin, fake } = withRecords([]);

    const first = await plugin.fetchRecent({ topic: TOPIC, since: asCursor('9') });
    expect(first.messages).toHaveLength(0);
    expect(first.nextCursor).not.toBe('9');

    fake.state.records.push({ seq: 1, data: payload('reborn') });
    expect(await drainFrom(plugin, first.nextCursor)).toEqual(['reborn']);
  });

  it('a cursor at the tail of a healthy stream still parks, and resumes on the next message', async () => {
    const { plugin, fake } = withRecords(ALL);

    const parked = await plugin.fetchRecent({ topic: TOPIC, since: asCursor('3') });
    expect(parked).toEqual({ messages: [], nextCursor: '3' });

    fake.state.records.push({ seq: 4, data: payload('d') });
    expect(await drainFrom(plugin, parked.nextCursor)).toEqual(['d']);
  });
});

const OLD_INCARNATION = '2026-01-01T00:00:00.000000000Z';
const NEW_INCARNATION = '2026-06-06T06:06:06.000000000Z';
const OLD = ['o1', 'o2', 'o3', 'o4', 'o5']; // the persisted cursor is minted at its tail, seq 5

const born = (contents: string[]): { seq: number; data: string }[] =>
  contents.map((c, i) => ({ seq: i + 1, data: payload(c) }));

const lives = (n: number): string[] => Array.from({ length: n }, (_, i) => `n${i + 1}`);

/** Length of the incarnation that replaces one the cursor was minted against, seq 5. */
const reprovisions = [
  { name: 'is empty', length: 0 },
  { name: 'is shorter than the persisted sequence', length: 2 },
  { name: 'reaches exactly the persisted sequence', length: 5 },
  { name: 'has just grown past the persisted sequence', length: 6 },
  { name: 'has grown far past the persisted sequence', length: 40 },
  { name: 'has grown past a default page', length: 150 },
];

const drains: { name: string; extra: { blockMs?: number; limit?: number } }[] = [
  ...reads,
  ...[3, 50].map((limit) => ({ name: `limit-${limit} catch-up`, extra: { limit } })),
];

describe('nats catch-up judges a cursor by the incarnation that minted it, not by the tail', () => {
  it('the table holds incarnations longer than the page that drains them', () => {
    const pages = drains.map((d) => d.extra.limit ?? 100);
    for (const limit of pages) {
      expect(reprovisions.some((r) => r.length > limit), `limit ${limit}`).toBe(true);
    }
  });

  for (const reprovision of reprovisions) {
    for (const read of drains) {
      it(`${read.name} from a cursor whose incarnation ${reprovision.name} drains everything it holds`, async () => {
        const live = lives(reprovision.length);
        const fake = fakeJetStream({ records: born(OLD), streamCreated: OLD_INCARNATION });
        const plugin = new NatsPlugin();
        injectFake(plugin, fake, TOPIC);
        const stale = (await plugin.fetchRecent({ topic: TOPIC })).nextCursor;

        fake.state.records = born(live);
        fake.state.streamCreated = NEW_INCARNATION;
        const page = await plugin.fetchRecent({ topic: TOPIC, since: stale, ...read.extra });
        const seen = [
          ...page.messages.map((m) => m.content),
          ...(await drainFrom(plugin, page.nextCursor, read.extra.limit)),
        ];

        expect(seen).toEqual(live);

        // …and the cursor that page hands back keeps working in the incarnation that is now live.
        fake.state.records.push({ seq: live.length + 1, data: payload('later') });
        expect(await drainFrom(plugin, page.nextCursor)).toContain('later');
      }, 30_000);
    }
  }
});

/** A valid cursor is a decimal sequence; each mutator turns one into something else. */
const decorate = (base: string): string[] => [
  ` ${base}`,
  `${base} `,
  `\u0009${base}`,
  `${base}\u000a`,
  `+${base}`,
  `-${base}`,
  `${base}.5`,
  `${base}e9`,
  `0x${base}`,
  `${base},${base}`,
  `${base}${'0'.repeat(20)}`,
  `${base}n`,
  `٢${base}`,
];
const junkCursors = [
  '',
  ' ',
  'abc',
  'Infinity',
  'NaN',
  'null',
  'undefined',
  'true',
  '{}',
  '[]',
  '1e999',
  '9007199254740992',
  '٢',
  '１',
  ...decorate('7'),
];

// Every row is pinned to ONE outcome for EVERY read shape: rejection, naming the offending value,
// with nothing created on the server. A table that instead branches on the outcome it is validating
// passes whether the cursor is rejected or silently coerced to "no since", which is the defect.
describe('nats rejects a cursor it could not have minted', () => {
  for (const junk of junkCursors) {
    it(`since=${JSON.stringify(junk)} rejects on every read shape and never reaches the server`, async () => {
      for (const read of reads) {
        const { plugin, fake } = withRecords(ALL);
        let pending: Promise<unknown> = Promise.resolve();

        // Keep the synchronous-throw check on every row: a throw OUT of a Promise-returning seam
        // method escapes every caller that only wrote `.catch()`.
        expect(() => {
          pending = plugin.fetchRecent({ topic: TOPIC, since: asCursor(junk), ...read.extra });
        }, read.name).not.toThrow();

        const rejection = await pending.then(
          () => new Error('resolved instead of rejecting'),
          (err: unknown) => (err instanceof Error ? err : new Error(String(err))),
        );
        expect(rejection.message, read.name).toMatch(/invalid nats cursor/);
        expect(rejection.message, read.name).toContain(JSON.stringify(junk));
        expect(fake.state.created, read.name).toEqual([]);
      }
    });
  }
});
