import { asCursor, asHandle, asTopic, type Cursor } from '@sharptrick/parley-core';
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_DEADLINE_MS,
  MAX_BACKOFF_MS,
} from '@sharptrick/parley-net-util';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DiscordPlugin, RECONNECT_CAP_MS } from '../src/index.js';
import { startFakeDiscord, type FakeDiscord } from './fake-discord.js';

// CLASS: a README paragraph describing a DEPENDENCY's behaviour, with nothing binding it to that
// dependency. The retry rule lives in net-util and has already changed once underneath this file;
// the numbers here are read from its exported constants and the behaviour is driven end to end, so
// the prose cannot drift into describing a loop the plugin no longer runs.

const README = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

/** Discord's own numbers: the per-token IDENTIFY quota and the window it is measured over. */
const QUOTA_PER_DAY = 1000;
const DAY_MS = 86_400_000;
const RATE_LIMITS = README.slice(README.indexOf('## Rate limits'), README.indexOf('## Provisioning'));

describe('bridge-discord README — the documented 429 rule is net-util’s actual rule', () => {
  it('carries the rate-limit section the seam mapping points at', () => {
    expect(RATE_LIMITS.length).toBeGreaterThan(0);
  });

  const NUMBERS: Array<[string, number]> = [
    ['the hintless default wait', DEFAULT_BACKOFF_MS],
    ['the ceiling on a self-invented backoff', MAX_BACKOFF_MS],
    ['the per-call deadline', DEFAULT_DEADLINE_MS],
  ];

  for (const [label, ms] of NUMBERS) {
    it(`states ${label} as ${ms} ms`, () => {
      expect(RATE_LIMITS).toContain(`${ms} ms`);
    });
  }
});

// CLASS: a README number a reader is invited to do ARITHMETIC with. The per-token IDENTIFY budget
// paragraph exists so an operator can size `gateway_dialers`; if its numbers drift from the ladder's
// exported constants, the advice becomes wrong in the direction that resets the bot token.
describe('bridge-discord README — the IDENTIFY quota arithmetic is the ladder’s', () => {
  const SESSIONS = README.slice(README.indexOf('## Multiple concurrent sessions'));

  it('carries the per-token quota section', () => {
    expect(SESSIONS).toContain('gateway_dialers');
    expect(SESSIONS).toContain(String(QUOTA_PER_DAY));
  });

  it(`states one instance's ceiling as ${DAY_MS / RECONNECT_CAP_MS} dials/day`, () => {
    expect(SESSIONS).toContain(`**${DAY_MS / RECONNECT_CAP_MS}**`);
  });

  it('states the cap the ladder actually applies', () => {
    expect(SESSIONS).toContain(`${RECONNECT_CAP_MS / 1000}s × gateway_dialers`);
  });
});

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
      const attach = await plugin
        .subscribe(topic, () => undefined)
        .then(() => 'resolves' as const, () => 'rejects' as const);

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

  it('names the terminal close codes the plugin actually treats as terminal', () => {
    expect(SUBSCRIBE_ROW).toContain('4004/4010–4014');
  });
});

// CLASS: a budget knob that silently bounds something the prose describes as unbounded. The
// seam-mapping row promised the window "is never silently truncated to 100" while `block_ms` — a
// model-chosen number, clamped from above and never floored — is the WHOLE call's budget, page walk
// included. A short page and "the topic has nothing older" are indistinguishable to the caller, so
// the claim and the clock have to be pinned together: the prose is asserted here AND driven.
describe('bridge-discord README — block_ms bounds the page walk, and says so', () => {
  // The ROW, not the section: the section also contains the long-poll paragraph below, so slicing
  // to it would let one sentence satisfy both of the prose cells.
  const NO_SINCE_ROW = README.slice(
    README.indexOf('| `fetchRecent` (no `since`)'),
    README.indexOf('| absent topic'),
  );
  const LONG_POLL = README.slice(
    README.indexOf('**`fetch_recent` long-poll'),
    README.indexOf('## Config'),
  );
  const COUPLING = /`block_ms` bounds the whole call, the page walk included/;

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

  it('states the coupling on the seam-mapping row that used to deny it', () => {
    expect(NO_SINCE_ROW).toMatch(COUPLING);
  });

  it('states the coupling where block_ms is introduced', () => {
    expect(LONG_POLL).toMatch(COUPLING);
  });

  it('no longer promises the window is never truncated', () => {
    expect(README).not.toMatch(/never silently truncated/);
  });

  /** What the README's prose says to expect: the full window, or the one page the budget bought. */
  const BUDGETS: Array<[string, number | undefined, (limit: number) => number]> = [
    ['no block_ms at all', undefined, (limit) => Math.min(limit, SEEDED)],
    ['a block_ms sized for the walk', 60_000, (limit) => Math.min(limit, SEEDED)],
    ['a block_ms of 1', 1, (limit) => Math.min(limit, PAGE)],
  ];
  const LIMITS = [PAGE, SEEDED];
  const POSITIONS: Array<[string, Cursor | undefined]> = [
    ['no since', undefined],
    ['since', asCursor('0')],
  ];

  for (const [position, since] of POSITIONS) {
    for (const limit of LIMITS) {
      for (const [budgetLabel, blockMs, expected] of BUDGETS) {
        it(`${position}, limit ${limit}, ${budgetLabel} → ${expected(limit)} messages`, async () => {
          const { messages } = await plugin.fetchRecent({
            topic,
            limit,
            ...(since !== undefined ? { since } : {}),
            ...(blockMs !== undefined ? { blockMs } : {}),
          });
          expect(messages).toHaveLength(expected(limit));
        });
      }
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

  it('refuses a stated wait past the call deadline instead of clamping it to the ceiling', async () => {
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
    // A clamped hint would have slept MAX_BACKOFF_MS and then SUCCEEDED on the retry.
    expect(elapsed).toBeLessThan(MAX_BACKOFF_MS);
    expect(fake.requestCount('/messages')).toBe(1);
  });
});
