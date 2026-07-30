import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { type FakeTelegram, KNOWN_CHANNEL } from './fake-telegram.js';
import { captureStderr, connectTo, registerCleanup, startFake, storePath } from './rig.js';

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
 * message missing any of them. `date` used to be the one field nothing checked, so a message
 * without it died on `new Date(undefined * 1000).toISOString()` — `RangeError: Invalid time value`,
 * which names neither the endpoint nor the field, and on the inbound path is one throttled stderr
 * line a minute for a whole class of permanently lost messages.
 *
 * Every required field x every way it can be wrong, through BOTH paths that build a record: the
 * `sendMessage` result (where a caller is there to reject) and the ingestion loop (where there is
 * not, so the loop must survive and say what it dropped and why).
 */
/** A Telegram `Message` object as it arrives — untyped, because a cell's job is to break it. */
type UpstreamMessage = Record<string, unknown>;

interface RequiredField {
  name: string;
  break: (m: UpstreamMessage, v: unknown) => UpstreamMessage;
  names: RegExp;
  /**
   * Values of the RIGHT type that the field's own use rejects. A field validated for its type but
   * not for its domain passes validation and dies later, unlabelled, at the point of use — which is
   * the whole reason validation lives here. Only a field whose use HAS a domain declares any.
   */
  outOfDomain?: { name: string; value: unknown }[];
}

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

const REQUIRED_FIELDS: RequiredField[] = [
  {
    name: 'message_id',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, message_id: v }),
    names: /message_id/,
  },
  { name: 'chat', break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, chat: v }), names: /chat id/ },
  {
    name: 'chat.id',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, chat: { id: v } }),
    names: /chat id/,
  },
  {
    name: 'date',
    break: (m: UpstreamMessage, v: unknown): UpstreamMessage => ({ ...m, date: v }),
    names: /date/,
    outOfDomain: [
      { name: 'far past the end of time', value: 1e15 },
      { name: 'far before the start of time', value: -1e15 },
      { name: 'one second past the last representable instant', value: MAX_DATE_SECONDS + 1 },
    ],
  },
];

/** `undefined` drops the key on the way through JSON; the other two are never a valid scalar. */
const BREAKAGES = [
  { name: 'absent', value: undefined },
  { name: 'null', value: null },
  { name: 'the wrong type', value: [] },
];

const FIELD_CELLS = REQUIRED_FIELDS.flatMap((field) =>
  [...BREAKAGES, ...(field.outOfDomain ?? [])].map((breakage) => ({ field, breakage })),
);

describe('telegram non-conforming message objects', () => {
  it.each(FIELD_CELLS)(
    'post rejects when the sendMessage result has $field.name $breakage.name, naming the endpoint and the field',
    async ({ field, breakage }) => {
      captureStderr();
      const fake = await startFake();
      const path = storePath();
      const plugin = await connectTo(fake, path);
      fake.malformMethod(
        'sendMessage',
        JSON.stringify({ ok: true, result: field.break(conformingMessage(), breakage.value) }),
      );

      const topic = asTopic(MESSAGE_CHAT);
      const err = await plugin.post(topic, SENDER, 'x').then(
        () => undefined,
        (e: unknown) => e as Error,
      );
      expect(err).toBeDefined();
      const message = err?.message ?? '';
      expect(message).toContain('Telegram POST /sendMessage');
      expect(message).toMatch(field.names);
      expect(message).not.toMatch(/Invalid time value|Cannot read properties/);
      // And nothing was recorded from a message object the plugin could not read.
      expect((await plugin.fetchRecent({ topic })).messages).toEqual([]);
    },
    20_000,
  );

  it.each(FIELD_CELLS)(
    'the ingestion loop drops an update whose message has $field.name $breakage.name, naming the endpoint and the field',
    async ({ field, breakage }) => {
      const stderr = captureStderr();
      const fake = await startFake();
      const plugin = await connectTo(fake, storePath());
      const topic = asTopic(MESSAGE_CHAT);
      await plugin.subscribe(topic, () => undefined);

      const updateId = fake.injectRawUpdate({
        message: field.break(conformingMessage(), breakage.value),
      });
      // A conforming message behind it pins the point at which the broken one has been consumed —
      // and proves the single ingestion path survived it.
      fake.injectUserMessage(MESSAGE_CHAT, 'alice', 'sentinel');
      await vi.waitFor(
        async () =>
          expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toContain(
            'sentinel',
          ),
        { timeout: 8000, interval: 20 },
      );

      const reported = stderr.join('');
      expect(reported).toContain(`Telegram GET /getUpdates → update ${updateId}`);
      expect(reported).toMatch(field.names);
      expect(reported).not.toMatch(/Invalid time value|Cannot read properties/);
      expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual([
        'sentinel',
      ]);
    },
    20_000,
  );

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
