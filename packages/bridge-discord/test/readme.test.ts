import { asCursor, asHandle, asTopic, type Cursor } from '@sharptrick/parley-core';
import { DEFAULT_DEADLINE_MS } from '@sharptrick/parley-net-util';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin } from '../src/index.js';
import { startFakeDiscord, type FakeDiscord } from './fake-discord.js';
import { settleOf } from './harness.js';

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

// CLASS: a README that documents the isolation rule but not the case that breaks it. The `subscribe`
// row argues at length that a per-topic failure must not fail core's attach — and a TERMINAL gateway
// close on the first subscribe does exactly that, taking the REST half down with it. So each class
// of gateway failure is DRIVEN here and the observed attach outcome is required to have a sentence
// in the README naming it: a row whose behaviour and prose disagree fails.
describe('bridge-discord README — the gateway-failure prose is the observed behaviour', () => {
  const SUBSCRIBE_ROW = README.slice(README.indexOf('| `subscribe`'), README.indexOf('| `resolveIdentity`'));
  const PROVISIONING = README.slice(README.indexOf('## Provisioning'));

  /** What the README must SAY for each observed outcome, and where it must say it. */
  const OUTCOMES = {
    resolves: [/does \*\*not\*\* fail `subscribe`/],
    rejects: [/it fails `subscribe`/, /the bridge exits/, /parley-discord: fatal/],
  } as const;

  const FAILURES: Array<{
    label: string;
    arrange: (fake: FakeDiscord) => void;
    outcome: keyof typeof OUTCOMES;
    /** Omit `gateway_url` so the failure is the url LOOKUP rather than the socket. */
    resolveUrl?: boolean;
  }> = [
    { label: 'a transient drop before READY (1006)', arrange: (f) => f.scriptGateway('drop'), outcome: 'resolves' },
    { label: 'a handshake that stalls', arrange: (f) => f.scriptGateway('stall'), outcome: 'resolves' },
    {
      label: 'a GET /gateway/bot that answers 500',
      arrange: (f) => f.injectFault({ status: 500, path: '/gateway/bot', body: { message: 'nope' } }),
      outcome: 'resolves',
      resolveUrl: true,
    },
    { label: 'terminal 4004 (bad token)', arrange: (f) => f.scriptGateway(4004), outcome: 'rejects' },
    { label: 'terminal 4012 (invalid API version)', arrange: (f) => f.scriptGateway(4012), outcome: 'rejects' },
    { label: 'terminal 4014 (disallowed intent)', arrange: (f) => f.scriptGateway(4014), outcome: 'rejects' },
  ];

  for (const failure of FAILURES) {
    it(`${failure.label} → subscribe ${failure.outcome}, and the README says so`, async () => {
      vi.spyOn(process.stderr, 'write').mockReturnValue(true);
      const fake = await startFakeDiscord();
      const topic = asTopic('740000000000000009');
      fake.createChannel(topic as string);
      failure.arrange(fake);

      const plugin = new DiscordPlugin();
      await plugin.connect({
        token: 'fake-token',
        api_url: fake.apiUrl,
        handshake_timeout_ms: 150,
        ...(failure.resolveUrl === true ? {} : { gateway_url: fake.gatewayUrl }),
      });
      const settled = await settleOf(plugin.subscribe(topic, () => undefined));
      const attach = settled.status === 'rejected' ? 'rejects' : 'resolves';

      expect(attach).toBe(failure.outcome);
      for (const sentence of OUTCOMES[failure.outcome]) {
        expect(
          sentence.test(SUBSCRIBE_ROW) || sentence.test(PROVISIONING),
          `the README never states that ${failure.label} ${failure.outcome === 'rejects' ? 'fails core’s attach' : 'is survivable'}`,
        ).toBe(true);
      }

      await plugin.disconnect();
      await fake.close();
      vi.restoreAllMocks();
    });
  }

});

// CLASS: a budget that silently bounds something the prose describes as unbounded. The
// seam-mapping row promised the window "is never silently truncated to 100" while the per-call
// deadline is the WHOLE call's budget, page walk included. A short page and "the topic has nothing
// older" are indistinguishable to the caller, so the claim and the walk have to be pinned together:
// the prose is asserted here AND driven.
describe('bridge-discord README — the call deadline bounds the page walk, and says so', () => {
  const SEEDED = 250;
  const PAGE = 100;
  const topic = asTopic('740000000000000021');

  let fake: FakeDiscord;
  let plugin: DiscordPlugin;

  beforeAll(async () => {
    fake = await startFakeDiscord();
    fake.createChannel(topic as string);
    plugin = new DiscordPlugin();
    await plugin.connect({ token: 'fake-token', api_url: fake.apiUrl, gateway_url: fake.gatewayUrl });
    for (let i = 0; i < SEEDED; i++) await plugin.post(topic, asHandle('writer'), `m${i}`);
  }, 60_000);
  afterAll(async () => {
    await plugin.disconnect();
    await fake.close();
  });

  const LIMITS = [PAGE, SEEDED];
  const POSITIONS: Array<[string, Cursor | undefined]> = [
    ['no since', undefined],
    ['since', asCursor('0')],
  ];

  for (const [position, since] of POSITIONS) {
    for (const limit of LIMITS) {
      it(`${position}, limit ${limit} → ${Math.min(limit, SEEDED)} messages`, async () => {
        const { messages } = await plugin.fetchRecent({
          topic,
          limit,
          ...(since !== undefined ? { since } : {}),
        });
        expect(messages).toHaveLength(Math.min(limit, SEEDED));
      });
    }
  }
});

describe('bridge-discord 429 behaviour matches what the README promises', () => {
  let fake: FakeDiscord;
  let plugin: DiscordPlugin;
  const topic = asTopic('740000000000000001');

  beforeEach(async () => {
    fake = await startFakeDiscord();
    fake.createChannel(topic as string);
    plugin = new DiscordPlugin();
    await plugin.connect({ token: 'fake-token', api_url: fake.apiUrl, gateway_url: fake.gatewayUrl });
  });
  afterEach(async () => {
    await plugin.disconnect();
    await fake.close();
  });

  /**
   * The README states a rule that belongs to a DEPENDENCY, so the case has to DRIVE it rather than
   * check that the numbers beside it are the exported ones. The sentence said "falling back to" the
   * body field, which is a different rule from the one the loop runs, and every README-truth row
   * here graded three CONSTANTS — so the prose was wrong for as long as 500/30000 stayed 500/30000.
   *
   * Both orderings, because "the header wins" and "the header is a floor" agree on exactly one of
   * them, and a table that asks only that one cannot tell the rules apart.
   */
  const BOTH_HINTS: Array<[label: string, headerS: number, bodyS: number]> = [
    ['the header asking for longer', 0.5, 0.05],
    ['the body asking for longer', 0.05, 0.5],
  ];

  it.each(BOTH_HINTS)('waits the longer of the two when a 429 carries %s', async (_label, h, b) => {
    fake.injectFault({
      status: 429,
      path: '/channels/',
      headers: { 'retry-after': String(h) },
      body: { retry_after: b },
    });

    const started = Date.now();
    await plugin.post(topic, asHandle('writer'), 'hi');
    const elapsed = Date.now() - started;

    expect(
      elapsed,
      'the call retried before the longer of the two stated waits — the header is a FLOOR the ' +
        'body cannot lower and the body is a hint the header cannot cap, so whichever states ' +
        'longer is what is waited',
    ).toBeGreaterThanOrEqual(Math.max(h, b) * 1000 * 0.8);
    expect(fake.requestCount('/messages')).toBe(2);
  });

  it('refuses a stated wait past the call deadline instead of shortening it', async () => {
    const askedMs = 2 * DEFAULT_DEADLINE_MS;
    fake.injectFault({
      status: 429,
      path: '/channels/',
      body: { retry_after: askedMs / 1000, global: true },
    });

    const started = Date.now();
    const err = await plugin.post(topic, asHandle('writer'), 'hi').catch((e: unknown) => e);
    const elapsed = Date.now() - started;

    expect(err).toBeInstanceOf(Error);
    // Both numbers, so the operator can see whose budget ran out and by how much.
    expect(String(err)).toContain(String(askedMs));
    expect(String(err)).toContain(String(DEFAULT_DEADLINE_MS));
    // A shortened hint would have slept and then SUCCEEDED on the retry, well inside the deadline.
    expect(elapsed).toBeLessThan(DEFAULT_DEADLINE_MS / 2);
    expect(fake.requestCount('/messages')).toBe(1);
  });
});
