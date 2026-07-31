/**
 * Two CLASSES of input the plugin cannot trust:
 *
 * (1) CONFIG. A topic → channel map is many-to-one by construction. Two topics folding onto one
 *     channel is not a merge, it is a silent displacement: one topic's handler stops firing and
 *     that channel's traffic is delivered under the OTHER topic's name, crossing into a different
 *     topic's dedup and allowlist namespace. It must fail at load, naming both topics.
 *
 * (2) HISTORY. One unexpected record in a `conversations.history` page must not reject the call and
 *     must not mint an empty `backendMsgId`/`cursor` — an empty dedup key collapses every message
 *     that carries it, and a rejection that repeats on every catch-up wedges the topic forever,
 *     because the cursor never advances past the record that caused it.
 */
import { asCursor, asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  compareTs,
  MAX_TIMER_MS,
  requireUsableSocketUrl,
  SlackPlugin,
  TIMER_CONFIG_KEYS,
  TOKEN_CONFIG_KEYS,
  TS_RE,
} from '../src/index.js';
import { FakeSlack } from './fake-slack.js';
import { capture, settleWithin, sleep, startSlack } from './harness.js';

/** A row label for a value `JSON.stringify` renders as `undefined` (a function) or not at all. */
const shapeOf = (v: unknown): string =>
  typeof v === 'function' ? 'a function' : (JSON.stringify(v) ?? String(v));

const COLLIDING: Array<{ name: string; map: Record<string, string>; topics: [string, string] }> = [
  {
    name: 'two mapped topics on one channel',
    map: { alpha: 'C0SHARED', beta: 'C0SHARED' },
    topics: ['alpha', 'beta'],
  },
  {
    name: 'three mapped topics, two of them colliding',
    map: { alpha: 'C0A', beta: 'C0SHARED', gamma: 'C0SHARED' },
    topics: ['beta', 'gamma'],
  },
  {
    name: 'a topic mapped to the channel another topic is named after',
    map: { alpha: 'C0LITERAL', C0LITERAL: 'C0LITERAL' },
    topics: ['alpha', 'C0LITERAL'],
  },
];

describe('slack colliding topic → channel mappings', () => {
  for (const row of COLLIDING) {
    it(`connect rejects ${row.name}, naming both topics`, async () => {
      const plugin = new SlackPlugin();
      await expect(
        plugin.connect({ api_url: 'http://127.0.0.1:1/api', channel_map: row.map }),
      ).rejects.toThrow(new RegExp(`${row.topics[0]}[\\s\\S]*${row.topics[1]}`));
    });
  }

  it('accepts a map whose targets are distinct, including near-miss ids', async () => {
    const plugin = new SlackPlugin();
    await plugin.connect({
      api_url: 'http://127.0.0.1:1/api',
      channel_map: { alpha: 'C0AAA', beta: 'C0AAB', gamma: 'c0aaa' },
    });
    await plugin.disconnect();
  });

  /**
   * A mapped topic and an unmapped channel-id literal collide only at USE, so the guard has to live
   * on every seam method, not just `subscribe`. The documented chat default runs with live push OFF
   * and never calls `subscribe` at all, so a guard that only exists there leaves the reactive
   * deployment — the common one — silently running two topics over one channel.
   */
  const ENTRY_POINTS: Array<{ name: string; use: (p: SlackPlugin, t: Topic) => Promise<unknown> }> = [
    { name: 'subscribe', use: (p, t) => p.subscribe(t, () => undefined) },
    { name: 'post', use: (p, t) => p.post(t, asHandle('writer'), 'meant for the other topic') },
    { name: 'fetchRecent', use: (p, t) => p.fetchRecent({ topic: t, limit: 10 }) },
    {
      name: 'fetchRecent-since',
      use: (p, t) => p.fetchRecent({ topic: t, since: asCursor('0'), limit: 10 }),
    },
  ];

  /**
   * Ownership must come from CONFIGURATION, not from call order. An ad-hoc `post`/`fetch_recent`
   * naming a channel-id literal is a documented use case (DESIGN §14) and its topic is steerable by
   * prompt-injected inbound content, so a literal that claimed first would let one call permanently
   * disable a configured topic. Each row therefore drives BOTH orders: the configured topic must win
   * whichever side calls first, and the literal must be the rejected one either way.
   */
  async function withAliasingPlugin(
    body: (plugin: SlackPlugin) => Promise<void>,
  ): Promise<void> {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({
      api_url: fake.apiUrl,
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
      channel_map: { alpha: 'C0LIT' },
    });
    fake.createChannel('C0LIT');
    try {
      await body(plugin);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  }

  const COLLISION = /alpha[\s\S]*C0LIT|C0LIT[\s\S]*alpha/;

  /** The configured topic is still fully usable — the rejection displaced nothing. */
  async function expectMappedTopicHealthy(plugin: SlackPlugin, text: string): Promise<void> {
    await plugin.post(asTopic('alpha'), asHandle('writer'), text);
    const { messages } = await plugin.fetchRecent({ topic: asTopic('alpha'), limit: 10 });
    expect(messages.at(-1)?.content).toBe(text);
  }

  for (const first of ENTRY_POINTS) {
    for (const second of ENTRY_POINTS) {
      it(`the unmapped literal loses the collision whichever side calls first: ${first.name} then ${second.name}`, async () => {
        // `C0LIT` is unmapped, so it is used as a channel-id literal — `alpha`'s channel.
        await withAliasingPlugin(async (plugin) => {
          await first.use(plugin, asTopic('alpha'));
          await expect(second.use(plugin, asTopic('C0LIT'))).rejects.toThrow(COLLISION);
          await expectMappedTopicHealthy(plugin, 'kept after the literal was rejected');
        });
        await withAliasingPlugin(async (plugin) => {
          await expect(first.use(plugin, asTopic('C0LIT'))).rejects.toThrow(COLLISION);
          await second.use(plugin, asTopic('alpha'));
          await expectMappedTopicHealthy(plugin, 'kept though the literal called first');
        });
      });
    }
  }

  it('subscribe keeps the first topic live after rejecting the aliasing one', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({
      api_url: fake.apiUrl,
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
      channel_map: { alpha: 'C0LIT' },
    });
    fake.createChannel('C0LIT');
    try {
      const received: Array<{ topic: string; content: string }> = [];
      await plugin.subscribe(asTopic('alpha'), (m) =>
        received.push({ topic: String(m.topic), content: m.content }),
      );
      await expect(plugin.subscribe(asTopic('C0LIT'), () => undefined)).rejects.toThrow(/alpha/);

      // The first topic's route is intact: the rejected subscribe did not displace it.
      await plugin.post(asTopic('alpha'), asHandle('writer'), 'kept');
      await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 3000, interval: 10 });
      expect(received[0]).toEqual({ topic: 'alpha', content: 'kept' });
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});

/**
 * CLASS: an untrusted key indexed against a plain object literal. `topics`/`post_topics` in core are
 * `z.string().min(1)`, so every one of these is a legal topic, and a `channel_map` lookup that walks
 * the prototype chain answers for all of them: `Object.prototype` values stand in for configured
 * entries, and the resulting channel is an object — which degrades into a route no `event.channel`
 * string can match (a silent no-op) or a form field that reads `"undefined"` (a false
 * `NoSuchTopicError` against a channel that exists). Mirrors `bridge-core`'s own guard in
 * `engine/read-state.ts`, so the class is graded at both layers.
 */
const META_KEYS = ['__proto__', 'constructor', 'prototype', 'toString', 'valueOf', 'hasOwnProperty'];

describe('slack meta-key topics resolve to their own channel-id literal, never a prototype member', () => {
  for (const key of META_KEYS) {
    it(`\`${key}\` is used verbatim as a channel id on every seam entry point`, async () => {
      const fake = await FakeSlack.start();
      const plugin = new SlackPlugin();
      // A neighbouring mapped topic, so the map is a populated object rather than an empty one.
      await plugin.connect({
        api_url: fake.apiUrl,
        bot_token: 'xoxb-test',
        app_token: 'xapp-test',
        channel_map: { neighbour: 'C0NEIGHBOUR' },
      });
      const topic = asTopic(key);
      try {
        // The channel is created under the KEY ITSELF: the plugin must address that exact id, so a
        // lookup answering with a prototype member turns every call below into channel_not_found.
        fake.createChannel(key);
        const live: string[] = [];
        await plugin.subscribe(topic, (m) => live.push(m.content));

        const id = await plugin.post(topic, asHandle('writer'), `posted to ${key}`);
        expect(String(id).length).toBeGreaterThan(0);

        const recent = await plugin.fetchRecent({ topic, limit: 10 });
        expect(recent.messages.map((m) => m.content)).toEqual([`posted to ${key}`]);
        const since = await plugin.fetchRecent({ topic, since: asCursor('0'), limit: 10 });
        expect(since.messages.map((m) => m.content)).toEqual([`posted to ${key}`]);

        // A route keyed by anything but the channel-id string is a subscription that never fires.
        await vi.waitFor(() => expect(live).toEqual([`posted to ${key}`]), {
          timeout: 3000,
          interval: 10,
        });
      } finally {
        await plugin.disconnect();
        await fake.close();
      }
    });
  }

  it('a meta key MAPPED in channel_map still resolves to its configured channel', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    // Computed keys, so that `__proto__` is an OWN property rather than the literal's proto setter.
    await plugin.connect({
      api_url: fake.apiUrl,
      bot_token: 'xoxb-test',
      channel_map: { ['__proto__']: 'C0PROTO', ['constructor']: 'C0CTOR' },
    });
    try {
      for (const [key, channel] of [
        ['__proto__', 'C0PROTO'],
        ['constructor', 'C0CTOR'],
      ] as const) {
        fake.createChannel(channel);
        await plugin.post(asTopic(key), asHandle('writer'), `into ${channel}`);
        const { messages } = await plugin.fetchRecent({ topic: asTopic(key), limit: 10 });
        expect(messages.map((m) => m.content), key).toEqual([`into ${channel}`]);
      }
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });

  /**
   * CLASS: every `Record<string, string>` in `backend_config` whose values reach a `Message` field or
   * the wire. `backend_config` is opaque to core, so this plugin is the ONLY layer that ever sees
   * these values — and each map spends them somewhere unforgiving: a `channel_map` target becomes a
   * form field (`"undefined"`, a JSON blob), a `mention_map` value becomes `Message.senderHandle`
   * directly, reintroducing exactly the empty/non-string handle `senderOf`'s fallback exists to
   * prevent. Both must fail at LOAD, naming the offending key.
   */
  const CONFIG_MAPS = [
    { key: 'channel_map', what: 'a channel id' },
    { key: 'mention_map', what: 'a handle' },
  ] as const;
  const UNUSABLE_TARGETS = [null, 42, true, {}, [], ''];

  for (const map of CONFIG_MAPS) {
    for (const bad of UNUSABLE_TARGETS) {
      it(`rejects a ${map.key} value of ${JSON.stringify(bad)}, naming the key`, async () => {
        const plugin = new SlackPlugin();
        await expect(
          plugin.connect({
            api_url: 'http://127.0.0.1:1/api',
            [map.key]: { alpha: bad },
          } as unknown as Record<string, unknown>),
        ).rejects.toThrow(new RegExp(`${map.key}[\\s\\S]*alpha[\\s\\S]*not ${map.what}`));
      });
    }
  }

  /**
   * CLASS: the CONTAINER shape of a `backend_config` value, which the declared TypeScript type
   * cannot enforce at run time either. The table above varies a map's VALUES, so it can never look
   * at the map itself — and `Object.entries` destructures a string or an array as happily as an
   * object, so `channel_map: "C0123"` becomes `{"0":"C","1":"0",…}`: every configured topic then
   * falls through to the channel-id-literal branch, resolves to a channel that does not exist, and
   * comes back as `NoSuchTopicError` — which core reads as "topic not present yet" and logs and
   * skips. The bridge comes up reporting success, wired to nothing.
   *
   * `null` is a row because the declared type does not admit it either: defaulting it to an empty
   * map would be a coercion, which is the thing this whole describe block exists to refuse.
   */
  const UNUSABLE_CONTAINERS: unknown[] = ['C0123', ['C1', 'C2'], 42, true, null, () => 1];

  for (const map of CONFIG_MAPS) {
    for (const bad of UNUSABLE_CONTAINERS) {
      it(`rejects a ${map.key} that is ${shapeOf(bad)}, naming the key`, async () => {
        const plugin = new SlackPlugin();
        await expect(
          plugin.connect({
            api_url: 'http://127.0.0.1:1/api',
            [map.key]: bad,
          } as unknown as Record<string, unknown>),
        ).rejects.toThrow(new RegExp(`${map.key}[\\s\\S]*not accepted`));
      });
    }
  }

  /**
   * The same class one field along: a token is spent as an `Authorization: Bearer` header, so a
   * number reaches slack.com as `Bearer 12345` and comes back as a vendor auth error naming nothing
   * the operator can act on. Driven off the source's own key list, so a credential added without a
   * validation row fails HERE rather than on the wire.
   */
  for (const key of TOKEN_CONFIG_KEYS) {
    for (const bad of [42, true, null, {}, ['xoxb-test']] as unknown[]) {
      it(`rejects ${key} of ${shapeOf(bad)}, naming the key`, async () => {
        const plugin = new SlackPlugin();
        await expect(
          plugin.connect({ api_url: 'http://127.0.0.1:1/api', [key]: bad } as unknown as Record<
            string,
            unknown
          >),
        ).rejects.toThrow(new RegExp(`${key}[\\s\\S]*not accepted[\\s\\S]*a string`));
      });
    }
  }

  it('accepts both maps when every value is a usable string, and omitted maps and string tokens', async () => {
    const plugin = new SlackPlugin();
    await plugin.connect({
      api_url: 'http://127.0.0.1:1/api',
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
      channel_map: { alpha: 'C0AAA' },
      mention_map: { U0PARLEY: 'alpha' },
    });
    await plugin.disconnect();
    // …and the empty config the accept rows above have to be measured against.
    await plugin.connect({ api_url: 'http://127.0.0.1:1/api' });
    await plugin.disconnect();
  });
});

/**
 * CLASS: every `backend_config` value the declared TypeScript type cannot enforce at run time.
 * `backend_config` is `z.record(z.unknown())` in core, so a number knob arrives unchecked and a
 * string knob may not be a string at all — and each one lands somewhere that fails silently rather
 * than loudly: a delay outside Node's timer range clamps to 1 ms (so the bound the knob exists to
 * SET is the one thing it cannot express), and a URL is where every credentialed call is sent.
 *
 * The timer rows are derived from the interface rather than listed, so a knob added without a
 * validation row fails HERE rather than reaching `setTimeout` unchecked.
 */
describe('slack backend_config knobs that reach a timer fail at load', () => {
  /**
   * The `?: number` keys `SlackBackendConfig` declares, read out of the source that declares them —
   * found by scanning `src/`, so that the interface moving between modules cannot make this
   * vacuous. A declaration this cannot find is a loud failure, never an empty list.
   */
  function numericConfigKeysInSource(): string[] {
    const srcDir = fileURLToPath(new URL('../src', import.meta.url));
    const src = readdirSync(srcDir)
      .filter((f) => f.endsWith('.ts'))
      .map((f) => readFileSync(join(srcDir, f), 'utf8'))
      .join('\n');
    const body = /export interface SlackBackendConfig \{([\s\S]*?)\n\}/.exec(src);
    expect(body, 'SlackBackendConfig interface not found under src/').not.toBeNull();
    return [...body![1]!.matchAll(/^ {2}(\w+)\?: number;$/gm)].map((m) => m[1]!);
  }

  it('every numeric knob the interface declares is validated', () => {
    const declared = numericConfigKeysInSource();
    // Both sides non-empty: an equality between two empty sets validates nothing.
    expect(declared.length, 'numeric knobs found in the interface').toBeGreaterThan(0);
    expect(new Set(TIMER_CONFIG_KEYS)).toEqual(new Set(declared));
  });

  /** Values `setTimeout` cannot use as the delay they claim to be — each clamps, wraps or throws. */
  const UNUSABLE_DELAYS = [0, -1, 1.5, NaN, Infinity, 2 ** 31, 2 ** 53, '10000', null, {}];

  for (const key of TIMER_CONFIG_KEYS) {
    for (const bad of UNUSABLE_DELAYS) {
      it(`rejects ${key} of ${JSON.stringify(bad) ?? String(bad)}, naming the key and the range`, async () => {
        const plugin = new SlackPlugin();
        await expect(
          plugin.connect({ api_url: 'http://127.0.0.1:1/api', [key]: bad } as unknown as Record<
            string,
            unknown
          >),
        ).rejects.toThrow(new RegExp(`${key}[\\s\\S]*at most ${MAX_TIMER_MS}`));
      });
    }

    it(`accepts ${key} across the usable range`, async () => {
      for (const good of [1, 10_000, MAX_TIMER_MS]) {
        const plugin = new SlackPlugin();
        await plugin.connect({ api_url: 'http://127.0.0.1:1/api', [key]: good });
        await plugin.disconnect();
      }
    });
  }
});

/**
 * CLASS: a credentialed endpoint taken from `backend_config`. Every backend in this repo takes one
 * under its own key (`api_url`, `homeserver_url`, `site_url`, …), and each has the same two
 * failure modes: a value that is not a URL at all, which must fail at LOAD naming the key rather
 * than as a `TypeError` from inside the plugin; and a plaintext remote origin, which ships the
 * bearer tokens across the network in the clear and must WARN, because nothing else about it fails.
 * Loopback is the fixture case and stays silent — but only when the host really is loopback, which
 * is why a DNS name shaped like one is a warning row rather than an excused one.
 */
describe('slack api_url: rejected when unusable, warned when it would leak the tokens', () => {
  const CREDENTIALED_URLS: Array<{ url: unknown; outcome: 'silent' | 'warns' | 'rejects' }> = [
    { url: undefined, outcome: 'silent' },
    { url: 'https://slack.com/api', outcome: 'silent' },
    { url: 'https://logger.internal.example/api', outcome: 'silent' },
    { url: 'http://127.0.0.1:1/api', outcome: 'silent' },
    { url: 'http://127.5.5.5/api', outcome: 'silent' },
    { url: 'http://localhost:1234/api', outcome: 'silent' },
    { url: 'http://[::1]:1234/api', outcome: 'silent' },
    { url: 'http://logger.internal.example/api', outcome: 'warns' },
    { url: 'http://10.0.0.5/api', outcome: 'warns' },
    // Shaped like loopback, resolved like any other name: a prefix match would excuse both.
    { url: 'http://127.0.0.1.example.com/api', outcome: 'warns' },
    { url: 'http://localhost.example.com/api', outcome: 'warns' },
    { url: '', outcome: 'rejects' },
    { url: 'not-a-url', outcome: 'rejects' },
    { url: 'ftp://example.com/api', outcome: 'rejects' },
    { url: '//example.com/api', outcome: 'rejects' },
    { url: 42, outcome: 'rejects' },
    { url: null, outcome: 'rejects' },
    { url: {}, outcome: 'rejects' },
    { url: ['http://example.com/api'], outcome: 'rejects' },
  ];

  for (const row of CREDENTIALED_URLS) {
    it(`${JSON.stringify(row.url) ?? 'an omitted api_url'} ${row.outcome}`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
      const plugin = new SlackPlugin();
      const config = {
        bot_token: 'xoxb-secret',
        app_token: 'xapp-secret',
        ...(row.url === undefined ? {} : { api_url: row.url }),
      } as unknown as Record<string, unknown>;
      try {
        if (row.outcome === 'rejects') {
          await expect(plugin.connect(config)).rejects.toThrow(/api_url[\s\S]*http\(s\) URL/);
          expect(warn, 'a refused config warns about nothing').not.toHaveBeenCalled();
          return;
        }
        await plugin.connect(config);
        const said = warn.mock.calls.map((c) => String(c[0])).join('\n');
        if (row.outcome === 'silent') {
          expect(said, 'warned about a safe endpoint').toBe('');
          return;
        }
        // The operator has to be able to act on it: which key, which origin, and what leaks.
        expect(said).toContain('api_url');
        expect(said).toContain(new URL(String(row.url)).origin);
        expect(said).toContain('bot_token');
        expect(said).toContain('app_token');
        // Never the credentials themselves — a warning that leaks them into the log is the defect.
        expect(said).not.toContain('xoxb-secret');
        expect(said).not.toContain('xapp-secret');
      } finally {
        await plugin.disconnect();
        warn.mockRestore();
      }
    });
  }
});

/**
 * CLASS: a URL a VENDOR RESPONSE hands us. `configRisks` grades the endpoint the operator wrote
 * down, but `apps.connections.open` answers with a second one — and that one carries the single-use
 * Socket Mode ticket, every workspace message and every ack. Held to no rule, an `ok:true` body from
 * a captive portal, a compromised proxy or a vendor change moves the whole live stream to cleartext
 * toward a host nobody configured, with no load error and nothing on stderr. The rule is
 * comparative, so both axes are rows: what the vendor handed out, and what the operator configured.
 * It will recur for any other endpoint a response hands over — a webhook callback, a media URL.
 */
const SECURE_API = 'https://slack.com/api';
const PLAINTEXT_API = 'http://recorder.internal.example/api';
const LOOPBACK_API = 'http://127.0.0.1:8080/api';

const VENDOR_URLS: Array<{
  apiUrl: string;
  url: unknown;
  outcome: 'accepted' | 'downgrade' | 'unusable';
}> = [
  { apiUrl: SECURE_API, url: 'wss://wss-primary.slack.com/link/?ticket=t', outcome: 'accepted' },
  { apiUrl: SECURE_API, url: 'ws://attacker.example/socket?ticket=t', outcome: 'downgrade' },
  { apiUrl: SECURE_API, url: 'ws://10.0.0.5:3000/socket', outcome: 'downgrade' },
  // Shaped like loopback, resolved like any other name — the prefix-match excuse.
  { apiUrl: SECURE_API, url: 'ws://127.0.0.1.example.com/socket', outcome: 'downgrade' },
  { apiUrl: SECURE_API, url: 'ws://127.0.0.1:8080/socket', outcome: 'accepted' },
  { apiUrl: SECURE_API, url: 'ws://localhost:8080/socket', outcome: 'accepted' },
  { apiUrl: SECURE_API, url: 'ws://[::1]:8080/socket', outcome: 'accepted' },
  // A loopback fixture and a recording proxy are the two configurations that legitimately run in
  // the clear; a `ws://` stream is no weaker than the `api_url` already alongside it.
  { apiUrl: LOOPBACK_API, url: 'ws://127.0.0.1:8080/socket', outcome: 'accepted' },
  { apiUrl: PLAINTEXT_API, url: 'ws://recorder.internal.example/socket', outcome: 'accepted' },
  { apiUrl: PLAINTEXT_API, url: 'ws://attacker.example/socket', outcome: 'accepted' },
  { apiUrl: SECURE_API, url: 'https://attacker.example/socket', outcome: 'unusable' },
  { apiUrl: SECURE_API, url: 'wsss://attacker.example/socket', outcome: 'unusable' },
  { apiUrl: SECURE_API, url: '', outcome: 'unusable' },
  { apiUrl: SECURE_API, url: 42, outcome: 'unusable' },
  { apiUrl: SECURE_API, url: null, outcome: 'unusable' },
  { apiUrl: SECURE_API, url: undefined, outcome: 'unusable' },
  { apiUrl: SECURE_API, url: { url: 'wss://ok.example/socket' }, outcome: 'unusable' },
];

describe('slack holds the websocket url a vendor response hands out to the configured transport', () => {
  for (const row of VENDOR_URLS) {
    it(`${JSON.stringify(row.url)} under ${row.apiUrl} is ${row.outcome}`, () => {
      if (row.outcome === 'accepted') {
        expect(requireUsableSocketUrl(row.apiUrl, row.url)).toBe(row.url);
        return;
      }
      const thrown = ((): Error => {
        try {
          requireUsableSocketUrl(row.apiUrl, row.url);
        } catch (e: unknown) {
          return e as Error;
        }
        throw new Error('requireUsableSocketUrl accepted it');
      })();
      expect(thrown.name).toBe('SlackShapeError');
      expect(thrown.message).toContain('apps.connections.open');
      if (row.outcome === 'unusable') {
        expect(thrown.message).toContain('no usable websocket url');
        return;
      }
      // An operator can only act on a refusal that names the origin it refused and the reason.
      expect(thrown.message).toContain(new URL(String(row.url)).origin);
      expect(thrown.message).toContain(row.apiUrl);
      expect(thrown.message).toContain('downgrade');
      // Never the ticket: a Socket Mode URL is a credential, and a message quoting it in full is
      // the leak the refusal exists to prevent.
      expect(thrown.message).not.toContain('ticket');
    });
  }

  it('the refusal is wired into the dial: a downgraded url never becomes a socket', async () => {
    const { fake, plugin, cleanup } = await startSlack({ channels: ['C0DOWN'] });
    try {
      fake.setWsUrl('ws://attacker.example/socket?ticket=secret');
      const outcome = await settleWithin(
        capture(plugin.subscribe(asTopic('C0DOWN'), () => undefined)),
        4000,
      );
      expect(outcome.status).toBe('rejected');
      expect(String((outcome as { reason: unknown }).reason)).toMatch(/downgrade the live stream/);
      await sleep(200);
      expect(fake.liveSockets, 'a refused url still opened a socket').toBe(0);
    } finally {
      await cleanup();
    }
  });
});

/**
 * One bad record, at each position it can occupy in a page, with and without a `since`.
 * `surfacesAs` names the rows that are legitimately deliverable — a subtype-less entry with a
 * well-formed `ts` IS a message, however odd its text — so the table states which is which rather
 * than letting "it did not crash" stand in for "it was classified correctly".
 */
const BAD_ENTRIES: Array<{ name: string; entry: unknown; surfacesAs?: string }> = [
  { name: 'no ts', entry: { type: 'message', text: 'bad', user: 'U0' } },
  { name: 'null ts', entry: { type: 'message', ts: null, text: 'bad', user: 'U0' } },
  { name: 'numeric ts', entry: { type: 'message', ts: 42, text: 'bad', user: 'U0' } },
  { name: 'empty ts', entry: { type: 'message', ts: '', text: 'bad', user: 'U0' } },
  { name: 'non-numeric ts', entry: { type: 'message', ts: 'abc', text: 'bad', user: 'U0' } },
  { name: 'three-part ts', entry: { type: 'message', ts: '1.2.3', text: 'bad', user: 'U0' } },
  {
    name: 'float-shaped ts as a JSON number',
    entry: { type: 'message', ts: 1700000000.1, text: 'bad' },
  },
  { name: 'null entry', entry: null },
  { name: 'no type', entry: { ts: '1700000000.000001', text: 'bad', user: 'U0' } },
  {
    name: 'null text',
    entry: { type: 'message', ts: '1700000000.000002', text: null, user: 'U0' },
    surfacesAs: '',
  },
  // RANGE, not shape: these match `\d+\.\d+` and reach `new Date(seconds * 1000)`, which THROWS
  // outside the Date range — a rejection the cursor can never advance past, i.e. a wedged topic.
  {
    name: 'ts seconds past the Date range',
    entry: { type: 'message', ts: '99999999999999999.000001', text: 'poison', user: 'U0' },
  },
  {
    name: 'ts with 400 seconds digits',
    entry: { type: 'message', ts: `${'9'.repeat(400)}.000001`, text: 'poison', user: 'U0' },
  },
  {
    name: 'ts with 400 suffix digits',
    entry: { type: 'message', ts: `1700000000.${'9'.repeat(400)}`, text: 'poison', user: 'U0' },
  },
  // IDENTITY, not shape: `senderHandle` must never be minted empty — the seam's own
  // well-formedness rule forbids it and core's identity filter and roster read it directly.
  {
    name: 'no user and no bot_id',
    entry: { type: 'message', ts: '1700000000.000003', text: 'ghost' },
    surfacesAs: 'ghost',
  },
  {
    name: 'null user, null bot_id',
    entry: { type: 'message', ts: '1700000000.000004', text: 'ghost', user: null, bot_id: null },
    surfacesAs: 'ghost',
  },
  {
    name: 'empty-string user',
    entry: { type: 'message', ts: '1700000000.000005', text: 'ghost', user: '' },
    surfacesAs: 'ghost',
  },
  {
    name: 'bot_id only',
    entry: { type: 'message', ts: '1700000000.000006', text: 'app post', bot_id: 'B0APP' },
    surfacesAs: 'app post',
  },
  // TEXT, not shape: the field this table used to hold fixed at a short literal. `text` is the one
  // attacker-controlled field with real length behind it (Slack's own limit is 40 000 characters),
  // and it is the field every rewrite runs over, so a page carrying one must still return promptly.
  // `vendor-markup.test.ts` grades the cost; these rows keep the CLASSIFICATION honest for the
  // lengths that reach it. Each is its own `ts`, so the expectations below stay position-independent.
  {
    name: 'a 40 000-character mention flood',
    entry: {
      type: 'message',
      ts: '1700000000.000007',
      text: '<@'.repeat(20_000),
      user: 'U0',
    },
    surfacesAs: '<@'.repeat(20_000),
  },
  {
    name: 'a 40 000-character unterminated mention',
    entry: {
      type: 'message',
      ts: '1700000000.000008',
      text: `<@${'a'.repeat(39_998)}`,
      user: 'U0',
    },
    surfacesAs: `<@${'a'.repeat(39_998)}`,
  },
  {
    name: 'a 40 000-character entity flood',
    entry: { type: 'message', ts: '1700000000.000009', text: '&amp;'.repeat(8_000), user: 'U0' },
    surfacesAs: '&'.repeat(8_000),
  },
];

const POSITIONS = ['only', 'first', 'middle', 'last'] as const;

async function seedWithBadEntry(
  fake: FakeSlack,
  topic: Topic,
  entry: unknown,
  position: (typeof POSITIONS)[number],
): Promise<string[]> {
  if (position === 'only') {
    fake.seedRaw(topic, [entry]);
    return [];
  }
  const before = position === 'first' ? 0 : position === 'middle' ? 2 : 4;
  const after = 4 - before;
  const good: string[] = [];
  if (before > 0) {
    good.push(...fake.seed(topic, Array.from({ length: before }, (_, i) => ({ text: `g${i}` }))).map((m) => m.text));
  }
  fake.seedRaw(topic, [entry]);
  if (after > 0) {
    good.push(
      ...fake
        .seed(topic, Array.from({ length: after }, (_, i) => ({ text: `h${i}` })))
        .map((m) => m.text),
    );
  }
  return good;
}

describe('slack history robustness: one hostile record must not wedge catch-up', () => {
  for (const bad of BAD_ENTRIES) {
    it(`survives a page containing an entry with ${bad.name}`, async () => {
      const fake = await FakeSlack.start();
      const plugin = new SlackPlugin();
      await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test' });
      try {
        for (const position of POSITIONS) {
          for (const withSince of [false, true]) {
            const topic = asTopic(`C0BAD${position}${withSince ? 'S' : ''}`);
            fake.createChannel(topic);
            const good = await seedWithBadEntry(fake, topic, bad.entry, position);

            const result = await plugin.fetchRecent(
              withSince ? { topic, since: asCursor('0'), limit: 100 } : { topic, limit: 100 },
            );

            // The bad entry's `ts` is always older than the fake's freshly minted ones, so a row
            // that legitimately surfaces lands ahead of the good entries.
            const expected = bad.surfacesAs === undefined ? good : [bad.surfacesAs, ...good];
            const where = `${bad.name} @${position} since=${withSince}`;
            expect(result.messages.map((m) => m.content), where).toEqual(expected);
            for (const m of result.messages) {
              expect(String(m.backendMsgId).length, where).toBeGreaterThan(0);
              expect(String(m.cursor).length, where).toBeGreaterThan(0);
              expect(String(m.senderHandle).length, where).toBeGreaterThan(0);
            }
            expect(String(result.nextCursor).length, where).toBeGreaterThan(0);
          }
        }
      } finally {
        await plugin.disconnect();
        await fake.close();
      }
    });
  }
});

/**
 * CLASS: a field that passes the SHAPE guard but not the RANGE guard, and — the reason this block was
 * rewritten — a test that RESTATES a guard it could import. The self-check below used to assert the
 * generator against a paraphrase (`\d+\.\d+`) rather than against `TS_RE`, so it could not fail: 85 of
 * its 121 rows are in fact REJECTED by the real guard, while the describe claimed every generated
 * string was admitted. Both arms are now named, and each row states which side of the guard it is on,
 * so tightening or loosening `TS_RE` moves rows across the split instead of quietly emptying it.
 */
const TS_WIDTHS = [1, 2, 9, 10, 11, 12, 13, 14, 17, 40, 400];

const GENERATED = TS_WIDTHS.flatMap((secs) =>
  TS_WIDTHS.map((sub) => `${'9'.repeat(secs)}.${'1'.repeat(sub)}`),
);
const ADMITTED = GENERATED.filter((ts) => TS_RE.test(ts));
const REJECTED = GENERATED.filter((ts) => !TS_RE.test(ts));

describe('slack ts range: the shape guard admits and rejects exactly what it says', () => {
  it('every generated row is classified by the exported guard, not by a paraphrase of it', () => {
    for (const ts of GENERATED) {
      const [secs = '', sub = ''] = ts.split('.');
      // The guard's own digit bounds, restated ONLY as the expectation — the guard itself is imported.
      expect(TS_RE.test(ts), ts).toBe(secs.length <= 12 && sub.length <= 12);
    }
    expect(GENERATED.length).toBe(TS_WIDTHS.length ** 2);
    // Both arms non-empty: a guard change that emptied either one would leave the tables below
    // asserting nothing while still passing.
    expect(ADMITTED.length).toBeGreaterThan(0);
    expect(REJECTED.length).toBeGreaterThan(0);
    expect(ADMITTED.length + REJECTED.length).toBe(GENERATED.length);
  });

  // Positive controls at the boundary, on both sides of the dot independently — the widths a
  // generated sweep can drift away from.
  it.each([
    ['12 seconds digits', `${'9'.repeat(12)}.1`, true],
    ['13 seconds digits', `${'9'.repeat(13)}.1`, false],
    ['12 suffix digits', `1.${'1'.repeat(12)}`, true],
    ['13 suffix digits', `1.${'1'.repeat(13)}`, false],
    ['12 on both sides', `${'9'.repeat(12)}.${'1'.repeat(12)}`, true],
    ['13 on both sides', `${'9'.repeat(13)}.${'1'.repeat(13)}`, false],
  ])('%s is %s', (_label, ts, admitted) => {
    expect(TS_RE.test(ts)).toBe(admitted);
  });

  it('history: every ADMITTED ts normalizes, and every REJECTED one is dropped', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test' });
    try {
      const topic = asTopic('C0TSGEN');
      const anchor = fake.seed(topic, [{ text: 'anchor' }])[0]!;
      fake.seedRaw(
        topic,
        GENERATED.map((ts) => ({ type: 'message', ts, text: `gen-${ts}`, user: 'U0' })),
      );

      for (const since of [undefined, asCursor('0'), asCursor(anchor.ts)]) {
        const where = `since=${String(since)}`;
        const result = await plugin.fetchRecent(
          since === undefined ? { topic, limit: 1000 } : { topic, since, limit: 1000 },
        );
        expect(String(result.nextCursor).length, where).toBeGreaterThan(0);
        const surfaced = new Set(result.messages.map((m) => String(m.backendMsgId)));
        for (const m of result.messages) {
          expect(Number.isNaN(Date.parse(m.timestamp)), where).toBe(false);
          expect(String(m.senderHandle).length, where).toBeGreaterThan(0);
          expect(String(m.cursor).length, where).toBeGreaterThan(0);
        }
        // Two independent filters meet here: the exclusive `oldest` floor, which legitimately hides
        // an admitted `ts` below it, and the shape guard. Only the second one is under test, so the
        // floor is applied to the expectation with the plugin's OWN comparator.
        const aboveFloor = (ts: string): boolean =>
          since === undefined || compareTs(ts, String(since)) > 0;
        // The admitted arm must actually ARRIVE — a guard that rejected everything would otherwise
        // satisfy "nothing malformed got through" perfectly.
        const expected = ADMITTED.filter(aboveFloor);
        expect(expected.length, `${where}: admitted rows in range`).toBeGreaterThan(0);
        for (const ts of expected) expect(surfaced.has(ts), `${where}: admitted ${ts}`).toBe(true);
        for (const ts of REJECTED) expect(surfaced.has(ts), `${where}: rejected ${ts}`).toBe(false);
      }
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });

  it('live push: every ADMITTED ts reaches the handler, every REJECTED one is dropped, socket survives', async () => {
    const fake = await FakeSlack.start();
    const plugin = new SlackPlugin();
    await plugin.connect({ api_url: fake.apiUrl, bot_token: 'xoxb-test', app_token: 'xapp-test' });
    try {
      const topic = asTopic('C0TSLIVE');
      fake.createChannel(topic);
      const seen: string[] = [];
      await plugin.subscribe(topic, (m) => {
        expect(Number.isNaN(Date.parse(m.timestamp))).toBe(false);
        seen.push(String(m.backendMsgId));
      });
      for (const ts of GENERATED) {
        fake.pushEnvelope({
          type: 'events_api',
          payload: { event: { type: 'message', channel: topic, ts, text: `gen-${ts}`, user: 'U0' } },
        });
      }
      // The socket is still serving afterwards — an envelope that killed it would strand this.
      await plugin.post(topic, asHandle('writer'), 'still alive');
      await vi.waitFor(() => expect(seen.length).toBeGreaterThan(ADMITTED.length), {
        timeout: 3000,
        interval: 10,
      });
      for (const ts of ADMITTED) expect(seen, `admitted ${ts}`).toContain(ts);
      for (const ts of REJECTED) expect(seen, `rejected ${ts}`).not.toContain(ts);
    } finally {
      await plugin.disconnect();
      await fake.close();
    }
  });
});

/**
 * CLASS: every field the plugin reads out of an `ok:true` envelope. `ok:true` is a claim about the
 * CALL, not about the body — a captive portal, a proxy error page or a vendor change answers 200
 * with fields that are absent, null or another type entirely. Unguarded, each one surfaces as an
 * engine-level `TypeError`/`SyntaxError` naming neither the method nor the plugin, and on
 * `conversations.history` it repeats on every catch-up, which is the wedged topic this file exists
 * to prevent. Every row therefore has to name the Slack method that produced it.
 */
async function withReplyingServer(
  reply: { text: string; contentType: string },
  body: (plugin: SlackPlugin) => Promise<void>,
): Promise<void> {
  const { createServer } = await import('node:http');
  const server = createServer((req, res) => {
    void (async () => {
      for await (const _ of req) void _;
      res.writeHead(200, { 'Content-Type': reply.contentType });
      res.end(reply.text);
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as { port: number };
  const plugin = new SlackPlugin();
  try {
    await plugin.connect({
      api_url: `http://127.0.0.1:${port}/api`,
      bot_token: 'xoxb-test',
      app_token: 'xapp-test',
    });
    await body(plugin);
  } finally {
    await plugin.disconnect();
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const OK_TRUE_READERS: Array<{
  method: string;
  field: string;
  /** A value of the wrong shape for this field — for a nested read, wrong one level down. */
  malformed: unknown;
  drive: (plugin: SlackPlugin) => Promise<unknown>;
}> = [
  {
    method: 'chat.postMessage',
    field: 'ts',
    malformed: 1700000000.1,
    drive: (p) => p.post(asTopic('C0OK'), asHandle('writer'), 'hi'),
  },
  {
    method: 'conversations.history',
    field: 'messages',
    malformed: { '0': { type: 'message', ts: '1700000000.000001' } },
    drive: (p) => p.fetchRecent({ topic: asTopic('C0OK'), since: asCursor('0'), limit: 10 }),
  },
  {
    method: 'users.lookupByEmail',
    field: 'user',
    malformed: { id: 42 },
    drive: (p) => p.resolveIdentity(asHandle('someone@example.com')),
  },
  {
    method: 'apps.connections.open',
    field: 'url',
    malformed: 'http://not-a-websocket.example',
    drive: (p) => p.subscribe(asTopic('C0OK'), () => undefined),
  },
];

const MALFORMED_BODIES: Array<{
  name: string;
  of: (field: string, malformed: unknown) => { text: string; contentType: string };
}> = [
  {
    name: 'the field absent',
    of: () => ({ text: JSON.stringify({ ok: true }), contentType: 'application/json' }),
  },
  {
    name: 'the field null',
    of: (field) => ({
      text: JSON.stringify({ ok: true, [field]: null }),
      contentType: 'application/json',
    }),
  },
  {
    name: 'the field the wrong shape',
    of: (field, malformed) => ({
      text: JSON.stringify({ ok: true, [field]: malformed }),
      contentType: 'application/json',
    }),
  },
  {
    name: 'a non-JSON 200 (captive portal)',
    of: () => ({ text: '<html>captive portal</html>', contentType: 'text/html' }),
  },
  { name: 'an empty 200', of: () => ({ text: '', contentType: 'application/json' }) },
  // Parses fine and is not an object, so the `ok` read itself is what throws without a guard.
  {
    name: 'a JSON 200 whose body is null',
    of: () => ({ text: 'null', contentType: 'application/json' }),
  },
];

describe('slack ok:true is not a promise that the field the caller reads is there', () => {
  for (const reader of OK_TRUE_READERS) {
    for (const shape of MALFORMED_BODIES) {
      it(`${reader.method} with ${shape.name} rejects, naming the method`, async () => {
        await withReplyingServer(shape.of(reader.field, reader.malformed), async (plugin) => {
          const outcome = await capture(reader.drive(plugin));
          expect(outcome.status, `${reader.method} / ${shape.name}`).toBe('rejected');
          expect(String((outcome as { reason: unknown }).reason)).toContain(reader.method);
        });
      });
    }
  }
});

/**
 * The `ts` rows above cover the SHAPE of the field; these cover its VALUE — strings the shape guard
 * admits and `TS_RE` does not, which would otherwise be branded as a dedup key that collapses with
 * every other unusable one.
 */
describe('slack post: an ok:true reply is not a promise that `ts` is usable', () => {
  for (const ts of ['', 'abc', '99999999999999999.000001']) {
    it(`rejects rather than branding an unusable dedup key: ts ${JSON.stringify(ts)}`, async () => {
      await withReplyingServer(
        { text: JSON.stringify({ ok: true, ts }), contentType: 'application/json' },
        async (plugin) => {
          await expect(plugin.post(asTopic('C0X'), asHandle('writer'), 'hi')).rejects.toThrow(
            /no usable ts/,
          );
        },
      );
    });
  }
});
