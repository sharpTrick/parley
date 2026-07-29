import { asCursor, asTopic, type Cursor } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { NatsPlugin } from '../src/index.js';
import { fakeJetStream, injectFake, payload, type FakeJetStream } from './fake-jetstream.js';

// Class 1: the backend store was RE-PROVISIONED under a persisted cursor. JetStream sequences
// restart at 1 in a recreated stream, so a cursor minted against the old one names a sequence the
// new one will not reach for a long time — or ever. Catch-up must fall back to the retained window,
// never park on that cursor and return empty pages forever while post/subscribe keep working.
// Class 2: `since` is caller input (`parley_fetch_recent` declares it as a plain string), so a
// value this plugin could not have minted must fail loudly. It may never become a permanently
// empty page whose `nextCursor` echoes the junk back while the stream demonstrably has messages.
const TOPIC = asTopic('cursors');
const STREAM = 'PARLEY_cursors';
const ALL = ['a', 'b', 'c'];

function withRecords(contents: string[]): { plugin: NatsPlugin; fake: FakeJetStream } {
  const fake = fakeJetStream({ records: contents.map((c, i) => ({ seq: i + 1, data: payload(c) })) });
  const plugin = new NatsPlugin();
  injectFake(plugin, fake, STREAM);
  return { plugin, fake };
}

/** Everything a reader still sees when it resumes from `cursor` and keeps following nextCursor. */
async function drainFrom(plugin: NatsPlugin, cursor: Cursor): Promise<string[]> {
  const seen: string[] = [];
  let since = cursor;
  for (let i = 0; i < 6; i++) {
    const page = await plugin.fetchRecent({ topic: TOPIC, since });
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
        const seen = [...page.messages.map((m) => m.content), ...(await drainFrom(plugin, page.nextCursor))];
        expect(ALL.slice(ALL.length - seen.length)).toEqual(seen);

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
