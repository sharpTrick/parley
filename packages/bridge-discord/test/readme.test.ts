import { asHandle, asTopic } from '@sharptrick/parley-core';
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_DEADLINE_MS,
  MAX_BACKOFF_MS,
} from '@sharptrick/parley-net-util';
import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
