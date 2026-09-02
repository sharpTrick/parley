/**
 * CLASS: a vendor-supplied field of a Slack record reaching code that assumes its DECLARED type.
 *
 * `SlackMessage` describes what Slack says it sends; nothing on the wire enforces it. Every field is
 * read somewhere — `ts` by `hasUsableTs`, `type`/`subtype` by `isPlainMessage`, `user`/`bot_id` by
 * `senderOf`, `channel` by `routeEnvelope`, `text` by the markup rewrites — and a read that assumes
 * the type either throws or mis-classifies. A throw on the HISTORY path escapes `fetchRecent`, and
 * the entry sits at or above the caller's cursor, so every later catch-up re-reads it and throws
 * again: the topic is wedged with no in-band recovery. On the LIVE path the same throw is swallowed
 * by the envelope catch, so the two paths silently disagree about the same record.
 *
 * So this grades the whole cross product — every DECLARED field × a hostile value of every JSON
 * type — through BOTH delivery paths, stating for each cell whether the record surfaces (and as
 * what) or is dropped. The field list is read out of the interface itself: a field added to
 * `SlackMessage` without a row here fails the coverage case rather than slipping through ungraded.
 */
import { asCursor, asTopic, type Message, type Topic } from '@sharptrick/parley-core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { SlackPlugin } from '../src/index.js';
import type { FakeSlack } from './fake-slack.js';
import { capture, startSlack } from './harness.js';
import { slackSourceText } from './source-tree.js';

/**
 * The fields `SlackMessage` DECLARES, read out of the source that declares them — found across
 * every module the build compiles, so that the interface moving between modules, or down into a
 * subdirectory, cannot make this vacuous. A declaration this cannot find is a loud failure, never
 * an empty list.
 */
function declaredFields(): string[] {
  const src = slackSourceText();
  const body = /export interface SlackMessage \{([\s\S]*?)\n\}/.exec(src);
  expect(body, 'SlackMessage interface not found under src/').not.toBeNull();
  const fields = [...body![1]!.matchAll(/^ {2}(\w+)\??: /gm)].map((m) => m[1]!);
  expect(fields.length, 'SlackMessage parsed to no fields; the scan has gone blind').toBeGreaterThan(
    0,
  );
  return fields;
}

/** Slack's own `text` ceiling — the largest legitimate value any of these fields can carry. */
const BIG = 'x'.repeat(40_000);

/** One value of every JSON type a field can arrive as, plus absence. */
const HOSTILE: Array<{ label: string; value: unknown }> = [
  { label: 'absent', value: undefined },
  { label: 'null', value: null },
  { label: 'zero', value: 0 },
  { label: 'a number', value: 42 },
  { label: 'true', value: true },
  { label: 'an empty string', value: '' },
  { label: 'an array', value: ['x'] },
  { label: 'an object', value: { x: 1 } },
  { label: 'a 40 000-character string', value: BIG },
];

/** `surfaces: null` means the record must be DROPPED; otherwise it is the exact content expected. */
interface Outcome {
  surfaces: string | null;
  sender?: string;
}

/** A cell states one outcome for both paths, or one per path where the paths legitimately differ. */
type Cell = Outcome | { history: Outcome; live: Outcome };

interface FieldSpec {
  /** The outcome for every value not named in {@link except}. */
  fallback: Cell;
  except?: Record<string, Cell>;
}

const BODY = 'body';
const SENDER = 'U0';
const ANCHOR = 'anchor';

const surfacesBody: Outcome = { surfaces: BODY, sender: SENDER };
const dropped: Outcome = { surfaces: null };

/**
 * The grid. Each cell is a literal expectation, never derived from the guard it grades — a cell
 * computed from `isPlainMessage` would move with any change to it and grade nothing.
 */
const EXPECTED: Record<string, FieldSpec> = {
  // Only the literal `'message'` is a message. Nothing else classifies, so nothing else surfaces.
  type: { fallback: dropped },
  // `ts` is the dedup key AND the order key; an unusable one must never reach `compareTs`,
  // `new Date(...)` or `asBackendMsgId`, so the whole row drops.
  ts: { fallback: dropped },
  // The field this class was found on: it reaches the mention/entity rewrites, which are string
  // methods. A non-string must surface as EMPTY rather than throwing — dropping it would advance
  // the cursor over a record that may be real content.
  text: {
    fallback: { surfaces: '', sender: SENDER },
    except: { 'a 40 000-character string': { surfaces: BIG, sender: SENDER } },
  },
  // Absent is a plain post; every other shape is either a system/mutation record or nonsense.
  subtype: { fallback: dropped, except: { absent: surfacesBody } },
  // The poster's id, with `senderOf`'s fallback for anything unusable — an empty `senderHandle`
  // breaks the seam's well-formedness rule.
  user: {
    fallback: { surfaces: BODY, sender: 'unknown' },
    except: { 'a 40 000-character string': { surfaces: BODY, sender: BIG } },
  },
  // `user` is present and wins the `senderOf` fallback chain, so `bot_id` cannot change the outcome.
  bot_id: { fallback: surfacesBody },
  // The one field the two paths legitimately read differently: a read NAMES its channel in the
  // request, so history ignores the field entirely; the live path routes on it and drops anything
  // that is not the string of a routed channel.
  channel: { fallback: { history: surfacesBody, live: dropped } },
  // A plain thread reply is not channel-level content: `conversations.history` never returns it, so
  // the live copy must not surface either. Only a STRING makes an entry a reply.
  thread_ts: {
    fallback: surfacesBody,
    except: { 'an empty string': dropped, 'a 40 000-character string': dropped },
  },
};

const cellFor = (field: string, label: string): Cell => {
  const spec = EXPECTED[field];
  expect(spec, `no expectation row for SlackMessage.${field}`).toBeDefined();
  return spec!.except?.[label] ?? spec!.fallback;
};

const outcomeFor = (field: string, label: string, path: 'history' | 'live'): Outcome => {
  const cell = cellFor(field, label);
  return 'surfaces' in cell ? cell : cell[path];
};

interface Row {
  field: string;
  label: string;
  value: unknown;
  /** Row-unique, so every row gets its own channel and cannot be graded on another row's traffic. */
  slot: string;
}

const ROWS: Row[] = declaredFields().flatMap((field, f) =>
  HOSTILE.map(({ label, value }, v) => ({ field, label, value, slot: `${f}X${v}` })),
);

/** The base record: a plain, well-formed post. Each row replaces exactly ONE field of it. */
const withField = (base: Record<string, unknown>, field: string, value: unknown): unknown => {
  const entry = { ...base };
  if (value === undefined) delete entry[field];
  else entry[field] = value;
  return entry;
};

const wellFormed = (m: Message, where: string): void => {
  expect(typeof m.content, `${where}: content must be a string`).toBe('string');
  expect(String(m.backendMsgId).length, `${where}: empty dedup key`).toBeGreaterThan(0);
  expect(String(m.cursor).length, `${where}: empty cursor`).toBeGreaterThan(0);
  expect(String(m.senderHandle).length, `${where}: empty senderHandle`).toBeGreaterThan(0);
};

describe('slack vendor field types: every declared field, every JSON shape', () => {
  it('covers exactly the fields SlackMessage declares', () => {
    expect(new Set(Object.keys(EXPECTED))).toEqual(new Set(declaredFields()));
    expect(ROWS.length).toBe(declaredFields().length * HOSTILE.length);
  });

  describe('history: one hostile field must not reject the call, now or on any later catch-up', () => {
    let fake: FakeSlack;
    let plugin: SlackPlugin;
    let cleanup: () => Promise<void>;
    beforeAll(async () => {
      ({ fake, plugin, cleanup } = await startSlack());
    });
    afterAll(async () => {
      await cleanup();
    });

    it.each(ROWS)('$field as $label', async ({ field, label, value, slot }) => {
      const where = `history: ${field} as ${label}`;
      const expected = outcomeFor(field, label, 'history');
      const topic = asTopic(`C0H${slot}`);
      fake.createChannel(topic);
      const entry = withField(
        { type: 'message', ts: fake.mintTs(), text: BODY, user: SENDER },
        field,
        value,
      );
      fake.seedRaw(topic, [entry]);
      fake.seed(topic, [{ text: ANCHOR }]);

      const contents = expected.surfaces === null ? [ANCHOR] : [expected.surfaces, ANCHOR];
      // Twice from the SAME cursor: a record at or above the cursor that rejects once rejects on
      // every later catch-up, which is the wedge this class produces.
      for (const [n, args] of [
        ['first catch-up', { topic, since: asCursor('0'), limit: 100 }],
        ['repeat catch-up from the same cursor', { topic, since: asCursor('0'), limit: 100 }],
        ['tail read', { topic, limit: 100 }],
      ] as const) {
        const settled = await capture(plugin.fetchRecent(args));
        expect(settled.status, `${where}: ${n} must not reject`).toBe('fulfilled');
        if (settled.status !== 'fulfilled') return;
        expect(
          settled.value.messages.map((m) => m.content),
          `${where}: ${n} surfaced the wrong records`,
        ).toEqual(contents);
        for (const m of settled.value.messages) wellFormed(m, `${where}: ${n}`);
        expect(String(settled.value.nextCursor).length, `${where}: ${n}`).toBeGreaterThan(0);
        if (expected.sender !== undefined) {
          expect(settled.value.messages[0]!.senderHandle, `${where}: ${n} sender`).toBe(
            expected.sender,
          );
        }
      }
    });
  });

  describe('live: the same record on the socket must classify the same way', () => {
    let fake: FakeSlack;
    let plugin: SlackPlugin;
    let cleanup: () => Promise<void>;
    beforeAll(async () => {
      ({ fake, plugin, cleanup } = await startSlack());
    });
    afterAll(async () => {
      await cleanup();
    });

    it.each(ROWS)('$field as $label', async ({ field, label, value, slot }) => {
      const where = `live: ${field} as ${label}`;
      const expected = outcomeFor(field, label, 'live');
      const topic = asTopic(`C0L${slot}`);
      fake.createChannel(topic);
      const seen: Message[] = [];
      await plugin.subscribe(topic, (m) => {
        seen.push(m);
      });

      const event = withField(
        { type: 'message', channel: topic as string, ts: fake.mintTs(), text: BODY, user: SENDER },
        field,
        value,
      );
      const id = fake.pushEnvelope({ type: 'events_api', payload: { event } });
      // A well-formed push AFTER it: the socket is still serving, and its arrival is the moment the
      // hostile record has demonstrably had its chance.
      fake.pushEnvelope({
        type: 'events_api',
        payload: {
          event: {
          type: 'message',
          channel: topic as string,
          ts: fake.mintTs(),
          text: ANCHOR,
          user: SENDER,
        },
        },
      });

      await vi.waitFor(
        () =>
          expect(seen.map((m) => m.content), `${where}: control never arrived`).toContain(ANCHOR),
        { timeout: 3000, interval: 10 },
      );
      const contents = expected.surfaces === null ? [ANCHOR] : [expected.surfaces, ANCHOR];
      expect(seen.map((m) => m.content), `${where}: delivered the wrong records`).toEqual(contents);
      for (const m of seen) wellFormed(m, where);
      if (expected.sender !== undefined) {
        expect(seen[0]!.senderHandle, `${where}: sender`).toBe(expected.sender);
      }
      // Ack discipline is upstream of classification: an envelope the plugin drops or throws on is
      // still acked, or Slack redelivers it and eventually drops the connection.
      await vi.waitFor(() => expect(fake.acked, `${where}: unacked`).toContain(id), {
        timeout: 3000,
        interval: 10,
      });
    });
  });
});
