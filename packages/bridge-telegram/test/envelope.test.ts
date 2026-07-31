import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { type FakeTelegram, KNOWN_CHANNEL } from './fake-telegram.js';
import {
  captureStderr,
  connectTo,
  packageSource,
  registerCleanup,
  startFake,
  startRig,
  storePath,
} from './rig.js';

const SENDER = asHandle('me');

/**
 * On the Bot API a 2xx says nothing about success — `ok` does. A middlebox, a captive portal or a
 * local Bot API server (`api_url` is a documented knob) can answer HTTP 200 with a refusal, with no
 * `result` at all, with a `result` of the wrong shape, or with something that is not JSON. Every one
 * of those used to sail through `connect`'s advertised fail-fast preflight and resurface as a
 * contextless `TypeError` on a field that was never there — naming neither the endpoint nor the
 * upstream — or, on `sendMessage`, AFTER Telegram had already accepted the message.
 *
 * The body is untrusted and a thrown message becomes an `isError` MCP result, i.e. model context, so
 * every cell also grades what the message is allowed to carry: bounded, and stripped of the control
 * and format characters that forge line structure or reverse it.
 */
const MALFORMED = [
  {
    name: 'ok:false with a description',
    body: '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}',
    expected: /ok:false: Bad Request: chat not found/,
  },
  { name: 'ok:true with no result', body: '{"ok":true}', expected: /ok:true with no result/ },
  {
    name: 'a result of the wrong type',
    body: '{"ok":true,"result":"not an object"}',
    expected: /→ result:/,
  },
  { name: 'an empty body', body: '', expected: /body: not JSON: <empty body>/ },
  {
    name: 'a JSON array instead of an envelope',
    body: '[{"ok":true}]',
    expected: /not a Bot API envelope/,
  },
  {
    // A bidi override, a NEL, a CSI, a line separator and forged line structure — the classes
    // net-util's sanitizer exists to flatten before an upstream body can become model context.
    name: 'a hostile non-JSON payload',
    body: '\u202EHOSTILE\u0085\u009B\n\nparley-telegram: everything is fine\u2028',
    expected: /body: not JSON/,
  },
  {
    name: 'a description carrying forged line structure',
    body: `{"ok":false,"description":"denied\\u202e\\u0085\\n\\nparley-telegram: retrying"}`,
    expected: /ok:false: denied/,
  },
  {
    name: 'a body far past the error-message bound',
    body: `HOSTILE-${'A'.repeat(200_000)}`,
    expected: /body: not JSON/,
  },
];

/** Every character `sanitizeBody` neutralizes — none may survive into a thrown message. */
const FORGEABLE = /[\p{Cc}\p{Cf}\u2028\u2029]/u;

const ENDPOINTS = [
  {
    name: 'getMe, on the connect preflight',
    method: 'getMe',
    label: 'Telegram GET /getMe',
    drive: async (fake: FakeTelegram, arm: () => void): Promise<unknown> => {
      arm();
      const plugin = new TelegramPlugin();
      registerCleanup(() => plugin.disconnect());
      return plugin.connect({
        token: fake.token,
        api_url: fake.url,
        store_path: storePath(),
        poll_timeout_s: 1,
      });
    },
  },
  {
    name: 'getChat, resolving an @name topic',
    method: 'getChat',
    label: 'Telegram GET /getChat',
    drive: async (fake: FakeTelegram, arm: () => void): Promise<unknown> => {
      const plugin = await connectTo(fake, storePath());
      arm();
      return plugin.fetchRecent({ topic: asTopic(KNOWN_CHANNEL.username) });
    },
  },
  {
    name: 'sendMessage, on post',
    method: 'sendMessage',
    label: 'Telegram POST /sendMessage',
    drive: async (fake: FakeTelegram, arm: () => void): Promise<unknown> => {
      const plugin = await connectTo(fake, storePath());
      arm();
      return plugin.post(asTopic('-1009610001'), SENDER, 'x');
    },
  },
];

const CELLS = ENDPOINTS.flatMap((endpoint) =>
  MALFORMED.map((malformed) => ({ endpoint, malformed })),
);

describe('telegram malformed 2xx envelopes', () => {
  it.each(CELLS)(
    '$endpoint.name rejects on $malformed.name, naming the endpoint',
    async ({ endpoint, malformed }) => {
      captureStderr();
      const fake = await startFake();
      const err = await endpoint
        .drive(fake, () => fake.malformMethod(endpoint.method, malformed.body))
        .then(
          () => undefined,
          (e: unknown) => e as Error,
        );

      expect(err).toBeDefined();
      const message = err?.message ?? '';
      expect(message).toMatch(malformed.expected);
      expect(message).toContain(endpoint.label);
      expect(message).not.toMatch(/Cannot read properties|is not valid JSON/);
      // What a hostile upstream may put in model context: flattened, and bounded.
      expect(message).not.toMatch(FORGEABLE);
      expect(message.length).toBeLessThan(4_096);
    },
    20_000,
  );

  /**
   * The same class on the one endpoint with no caller to reject: the shared ingestion loop. A
   * malformed answer must be a reported, retried failure — not a `TypeError` that escapes the loop
   * and takes the only getUpdates consumer down for the life of the process.
   */
  it.each(MALFORMED)('the ingestion loop survives $name from getUpdates', async ({ body }) => {
    const stderr = captureStderr();
    const fake = await startFake();
    fake.malformMethod('getUpdates', body);
    const plugin = await connectTo(fake, storePath());

    await vi.waitFor(() => expect(stderr.join('')).toContain('Telegram GET /getUpdates'), {
      timeout: 8000,
      interval: 20,
    });
    expect(stderr.join('')).toMatch(/retrying/);
    // The diagnostic is one line: an upstream cannot forge a second one inside it.
    const reported = stderr.filter((l) => l.includes('getUpdates'));
    expect(reported.length).toBeGreaterThan(0);
    for (const line of reported) expect(line.trimEnd()).not.toMatch(FORGEABLE);

    // It really recovers: once the upstream answers properly again, ingestion resumes.
    fake.malformMethod('getUpdates', undefined);
    const chat = '-1009610002';
    const topic = asTopic(chat);
    await plugin.subscribe(topic, () => undefined);
    fake.injectUserMessage(chat, 'alice', 'after the garbage');
    await vi.waitFor(
      async () =>
        expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toContain(
          'after the garbage',
        ),
      { timeout: 8000, interval: 20 },
    );
  }, 20_000);
});

const MESSAGE_CHAT = '-1009620001';

/** A conforming Telegram `Message`, before a cell breaks exactly one field of it. */
const conformingMessage = (): UpstreamMessage => ({
  message_id: 4242,
  chat: { id: Number(MESSAGE_CHAT) },
  date: 1_600_000_000,
  text: 'hi',
});

/**
 * One level below the envelope: the message OBJECT. `unwrapEnvelope` only proves the upstream
 * answered `{ok:true, result}` — it says nothing about the fields the plugin then reads off that
 * result, and a non-conforming local Bot API server or a rewriting middlebox can hand back a
 * message missing any of them, or carrying any of them as the wrong type. `date` used to be the one
 * field nothing checked, so a message without it died on `new Date(undefined * 1000).toISOString()`
 * — `RangeError: Invalid time value`, which names neither the endpoint nor the field. The body and
 * sender fields were the next layer of the same hole, and a worse one: they are not merely read,
 * they are PERSISTED. A `text` of `12345` was written to the JSONL store verbatim and every later
 * `fetchRecent` on that chat then threw `content.matchAll is not a function` — forever, across
 * restarts, with no Bot API history endpoint that could refill the topic.
 *
 * So: every field the plugin reads for a value x every way it can be wrong, through BOTH paths that
 * build a record — the `sendMessage` result (where a caller is there to reject) and the ingestion
 * loop (where there is not, so the loop must survive and say what it dropped and why) — and the
 * post-condition on every cell is the one the poison pill broke: the chat is still fetchable
 * afterwards, before AND after a cold restart onto the same store file.
 */
/** A Telegram `Message` object as it arrives — untyped, because a cell's job is to break it. */
type UpstreamMessage = Record<string, unknown>;

interface Breakage {
  name: string;
  value: unknown;
}

/**
 * Values that are never the field's declared type, indexed BY that type rather than shared across
 * every field: `12345` is a broken `text` and a perfectly good `message_id`, so one shared breakage
 * list would either miss the string fields or assert a rejection the numeric ones must not make.
 */
const NOT: Record<'string' | 'number' | 'object' | 'chatId', Breakage[]> = {
  string: [
    { name: 'null', value: null },
    { name: 'a number', value: 12345 },
    { name: 'an object', value: { evil: 1 } },
    { name: 'an array', value: ['x'] },
  ],
  number: [
    { name: 'null', value: null },
    { name: 'a numeric string', value: '12345' },
    { name: 'an object', value: { evil: 1 } },
    { name: 'an array', value: [] },
  ],
  object: [
    { name: 'null', value: null },
    { name: 'a number', value: 12345 },
    { name: 'a string', value: 'x' },
    // An array IS an object to `typeof`, which is the check a shape guard is written wrong as.
    { name: 'an array', value: ['x'] },
  ],
  chatId: [
    { name: 'null', value: null },
    { name: 'an object', value: { evil: 1 } },
    { name: 'an array', value: [] },
    { name: 'a boolean', value: true },
  ],
};

/** `undefined` drops the key on the way through JSON, which is how a field arrives absent. */
const ABSENT: Breakage = { name: 'absent', value: undefined };

/**
 * `date` is turned into an ISO timestamp, so its domain is the range `Date` can represent: a finite
 * number well outside it (`1e15` seconds) survived a `Number.isFinite` check and resurfaced as
 * `RangeError: Invalid time value` — naming neither endpoint nor field, and on the inbound path
 * costing the message permanently, because the update was acknowledged to Telegram before ingest
 * ran and the Bot API has no history endpoint to ask again. NaN and Infinity are absent as values
 * because they cannot cross the wire: `JSON.stringify` writes both as `null`, which the shared
 * `null` breakage already covers.
 */
const MAX_DATE_SECONDS = 8.64e12;

interface MessageField {
  name: string;
  break: (m: UpstreamMessage, v: unknown) => UpstreamMessage;
  names: RegExp;
  /** Values that are never this field's declared type. */
  wrong: Breakage[];
  /**
   * Whether the field being ABSENT is itself a refusal. `text`, `caption` and `from` are optional on
   * the wire — a photo carries no text and a channel post carries no sender — and their accepted
   * shapes are graded in `inbound.test.ts`; every other field the plugin reads must be there.
   */
  requiredWhenPresent: boolean;
  /**
   * Values of the RIGHT type that the field's own use rejects. A field validated for its type but
   * not for its domain passes validation and dies later, unlabelled, at the point of use — which is
   * the whole reason validation lives here. Only a field whose use HAS a domain declares any.
   */
  outOfDomain?: Breakage[];
}

const MESSAGE_FIELDS: MessageField[] = [
  {
    name: 'message_id',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, message_id: v }),
    names: /message_id/,
    wrong: NOT.number,
    requiredWhenPresent: true,
  },
  {
    name: 'chat',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, chat: v }),
    names: /chat id/,
    wrong: NOT.object,
    requiredWhenPresent: true,
  },
  {
    name: 'chat.id',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, chat: { id: v } }),
    names: /chat id/,
    wrong: NOT.chatId,
    requiredWhenPresent: true,
  },
  {
    name: 'date',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, date: v }),
    names: /date/,
    wrong: NOT.number,
    requiredWhenPresent: true,
    outOfDomain: [
      { name: 'far past the end of time', value: 1e15 },
      { name: 'far before the start of time', value: -1e15 },
      { name: 'one second past the last representable instant', value: MAX_DATE_SECONDS + 1 },
    ],
  },
  {
    name: 'text',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, text: v }),
    names: /non-string text/,
    wrong: NOT.string,
    requiredWhenPresent: false,
  },
  {
    // Broken while `text` still holds a perfectly good string: `contentOf` prefers `text`, so a
    // guard that ran only on the field it happens to USE would let this one straight through.
    name: 'caption',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, caption: v }),
    names: /non-string caption/,
    wrong: NOT.string,
    requiredWhenPresent: false,
  },
  {
    name: 'from',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, from: v }),
    names: /\bfrom\b/,
    wrong: NOT.object,
    requiredWhenPresent: false,
  },
  {
    name: 'from.id',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({
      ...m,
      from: { id: v, username: 'alice' },
    }),
    names: /from\.id/,
    wrong: NOT.number,
    requiredWhenPresent: true,
  },
  {
    name: 'from.username',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({
      ...m,
      from: { id: 7, username: v },
    }),
    names: /from\.username/,
    wrong: NOT.string,
    requiredWhenPresent: false,
  },
];

const breakagesOf = (field: MessageField): Breakage[] => [
  ...(field.requiredWhenPresent ? [ABSENT] : []),
  ...field.wrong,
  ...(field.outOfDomain ?? []),
];

/** The unlabelled deaths this validation exists to prevent, whatever the field. */
const UNLABELLED = /Invalid time value|Cannot read properties|is not a function|is not iterable/;

describe('telegram non-conforming message objects', () => {
  it.each(MESSAGE_FIELDS)(
    'post rejects a sendMessage result whose $name is broken, naming the endpoint and the field',
    async (field) => {
      captureStderr();
      const rig = await startRig();
      const topic = asTopic(MESSAGE_CHAT);

      for (const breakage of breakagesOf(field)) {
        rig.fake.malformMethod(
          'sendMessage',
          JSON.stringify({ ok: true, result: field.break(conformingMessage(), breakage.value) }),
        );
        const err = await rig.plugin.post(topic, SENDER, 'x').then(
          () => undefined,
          (e: unknown) => e as Error,
        );
        const message = err?.message ?? '';
        expect({ breakage: breakage.name, rejected: err !== undefined }).toEqual({
          breakage: breakage.name,
          rejected: true,
        });
        expect(message).toContain('Telegram POST /sendMessage');
        expect(message).toMatch(field.names);
        expect(message).not.toMatch(UNLABELLED);
      }

      // Nothing was recorded from a message object the plugin could not read — and the topic is
      // still answerable, which is what a persisted record of the wrong shape takes away.
      expect((await rig.plugin.fetchRecent({ topic })).messages).toEqual([]);
      await rig.plugin.disconnect();
      const restarted = await rig.restart();
      expect((await restarted.fetchRecent({ topic })).messages).toEqual([]);
    },
    30_000,
  );

  it.each(MESSAGE_FIELDS)(
    'the ingestion loop drops an update whose message has a broken $name, naming the endpoint and the field',
    async (field) => {
      const stderr = captureStderr();
      const rig = await startRig();
      const topic = asTopic(MESSAGE_CHAT);
      const sentinels: string[] = [];
      // A fresh instance per breakage, so that the inbound diagnostic's per-class throttle (one line
      // a minute) cannot hide what the SECOND breakage of a field reported — and so every cell is
      // graded across a cold restart onto the store file the one before it left behind.
      let plugin = rig.plugin;

      for (const breakage of breakagesOf(field)) {
        await plugin.subscribe(topic, () => undefined);
        const updateId = rig.fake.injectRawUpdate({
          message: field.break(conformingMessage(), breakage.value),
        });
        // A conforming message behind it pins the point at which the broken one has been consumed —
        // and proves the single ingestion path survived it.
        const sentinel = `sentinel after ${breakage.name}`;
        sentinels.push(sentinel);
        rig.fake.injectUserMessage(MESSAGE_CHAT, 'alice', sentinel);
        await vi.waitFor(
          async () =>
            expect(
              (await plugin.fetchRecent({ topic, limit: 100 })).messages.map((m) => m.content),
            ).toContain(sentinel),
          { timeout: 8000, interval: 20 },
        );

        const reported = stderr.join('');
        expect(reported).toContain(`Telegram GET /getUpdates → update ${updateId}`);
        expect(reported).toMatch(field.names);
        expect(reported).not.toMatch(UNLABELLED);
        expect(
          (await plugin.fetchRecent({ topic, limit: 100 })).messages.map((m) => m.content),
        ).toEqual(sentinels);
        await plugin.disconnect();
        plugin = await rig.restart();
      }

      // The broken updates left nothing behind, and the chat is still fetchable — including from a
      // cold start onto the same store file, which is where a persisted bad record would resurface.
      const reloaded = await plugin.fetchRecent({ topic, limit: 100 });
      expect(reloaded.messages.map((m) => m.content)).toEqual(sentinels);
      for (const m of reloaded.messages) {
        expect({ content: typeof m.content, sender: typeof m.senderHandle }).toEqual({
          content: 'string',
          sender: 'string',
        });
      }
    },
    30_000,
  );

  /**
   * The table above is only as wide as the field list somebody remembered to type into it. Read the
   * fields the plugin ACTUALLY reads for a value out of its source, so that a new normalization
   * field — another `caption`-like body spelling, another sender fallback — cannot be added without
   * a row here.
   */
  it('grades every field the plugin reads for a record value', () => {
    const source = packageSource();
    const bodyFields = /const BODY_FIELDS = \[([^\]]*)\]/.exec(source)?.[1] ?? '';
    const read = [...bodyFields.matchAll(/'([^']+)'/g)].map((m) => m[1] as string);
    const senderOf = /function senderOf\([\s\S]*?\n\}/.exec(source)?.[0] ?? '';
    for (const m of senderOf.matchAll(/msg\.(\w+)\.(\w+)/g)) read.push(`${m[1]}.${m[2]}`);
    // Guard the extractor: an expression that stops matching would make this lint vacuous.
    expect(read).toContain('text');
    expect(read).toContain('from.username');

    expect([...new Set(read)].sort()).toEqual(
      [...new Set(read)].filter((f) => MESSAGE_FIELDS.some((row) => row.name === f)).sort(),
    );
  });

  /**
   * The other edge of the same domain: a range check that refuses what it should accept silently
   * drops real traffic, and the endpoints of a range are where an off-by-one lives.
   */
  it.each([
    { name: 'the epoch', date: 0 },
    { name: 'the last representable instant', date: MAX_DATE_SECONDS },
    { name: 'the first representable instant', date: -MAX_DATE_SECONDS },
  ])('post accepts a sendMessage result dated $name', async ({ date }) => {
    captureStderr();
    const fake = await startFake();
    const plugin = await connectTo(fake, storePath());
    fake.malformMethod(
      'sendMessage',
      JSON.stringify({ ok: true, result: { ...conformingMessage(), date } }),
    );

    const topic = asTopic(MESSAGE_CHAT);
    await expect(plugin.post(topic, SENDER, 'x')).resolves.toBeDefined();
    const stored = (await plugin.fetchRecent({ topic })).messages;
    expect(stored).toHaveLength(1);
    expect(Date.parse(stored[0]?.timestamp ?? '')).toBe(date * 1000);
  }, 20_000);

  /**
   * `update_id` is the acknowledgement, not a record field: `Math.max(offset, NaN)` is NaN and NaN
   * is below nothing, so ONE id-less update from a non-conforming upstream would poison the offset
   * for the life of the loop — Telegram would then re-serve the whole backlog on every poll and the
   * bridge would never see another new message.
   */
  it('keeps acknowledging updates when one arrives with no update_id', async () => {
    captureStderr();
    const fake = await startFake();
    fake.malformMethod(
      'getUpdates',
      JSON.stringify({ ok: true, result: [{ message: conformingMessage() }] }),
    );
    const plugin = await connectTo(fake, storePath());
    const topic = asTopic(MESSAGE_CHAT);

    await vi.waitFor(() => expect(fake.callCount('getUpdates')).toBeGreaterThan(2), {
      timeout: 8000,
      interval: 20,
    });
    fake.malformMethod('getUpdates', undefined);
    fake.injectUserMessage(MESSAGE_CHAT, 'alice', 'after the id-less update');

    await vi.waitFor(
      async () =>
        expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toContain(
          'after the id-less update',
        ),
      { timeout: 8000, interval: 20 },
    );
    // The loop advanced its offset past the injected update rather than re-reading it forever.
    await vi.waitFor(() => expect(fake.retainedUpdates()).toBe(0), { timeout: 8000, interval: 20 });
  }, 20_000);
});
