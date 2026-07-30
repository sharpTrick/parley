import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Class: a constant that no input can reach, and the doc claim built on it. The occupancy re-entry
// backoff was `min(REJOIN_CEILING_MS, base * 2 ** (losses - 1))` with the loss counter giving up at
// six, so the largest wait the ladder could ever produce was 6.4 s and the 30 s ceiling was dead
// code — while the README advertised the ceiling as the plugin's behaviour. The existing storm cases
// bound the ladder from one side (a floor on the gap, a cap on the count), which is satisfied by any
// ladder at all. This asserts the ladder as DATA: every step within its own window, so a step that
// stops doubling, a base that changes, and a ceiling that clips a step all fail a row.

const mockState = vi.hoisted(() => ({ client: undefined as unknown }));
vi.mock('@xmpp/client', async () => {
  const actual = await vi.importActual<typeof import('@xmpp/client')>('@xmpp/client');
  return { ...actual, client: () => mockState.client };
});

import { REJOIN_MAX_WAIT_MS, XmppPlugin } from '../src/index.js';
import { FakeXmpp, priv } from './fake-xmpp.js';

const TOPIC = asTopic('t-ladder');
const BASE_MS = 200;
const LOSSES = 6;
/** Loss n waits `BASE_MS * 2 ** (n - 1)` plus up to `BASE_MS` of jitter. Derived, then pinned. */
const ladder = Array.from({ length: LOSSES }, (_, i) => BASE_MS * 2 ** i);

describe('XMPP occupancy re-entry walks a documented backoff ladder', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    mockState.client = undefined;
  });

  it('the ladder is 200, 400, 800, 1600, 3200, 6400 ms and its top step is the plugin maximum', () => {
    expect(ladder).toEqual([200, 400, 800, 1600, 3200, 6400]);
    expect(REJOIN_MAX_WAIT_MS).toBe(ladder[ladder.length - 1]);
  });

  it('each loss waits its own step, jitter included, and then it gives up', async () => {
    vi.useFakeTimers();
    const errors = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const fake = new FakeXmpp();
    fake.enforceOccupancy = true;
    mockState.client = fake;
    const plugin = new XmppPlugin();
    await plugin.connect({ password: 'a-real-secret', nick: 'ladder' });
    const room = priv(plugin).roomJid(TOPIC);
    await plugin.subscribe(TOPIC, (_m: Message) => undefined);
    await plugin.post(TOPIC, asHandle('a'), 'before');

    const isJoin = (i: number): boolean =>
      (fake.sent[i] as { is(n: string): boolean; attrs: Record<string, string> }).is('presence') &&
      (fake.sent[i]?.attrs.to ?? '').startsWith(`${room}/`);
    const joinTimes = (): number[] => fake.sentAt.filter((_, i) => isJoin(i));
    const before = joinTimes().length;

    fake.kickOnJoin = { statuses: ['332'] }; // a room that ends occupancy on every join
    fake.endOccupancy(room, { statuses: ['332'] });
    await vi.advanceTimersByTimeAsync(120_000);

    const times = joinTimes();
    expect(times).toHaveLength(before + LOSSES); // exactly the ladder's length, then it stops
    const gaps = times.slice(before - 1).map((t, i, all) => (i === 0 ? 0 : t - (all[i - 1] as number)));
    for (const [step, expected] of ladder.entries()) {
      expect(gaps[step + 1]).toBeGreaterThanOrEqual(expected);
      expect(gaps[step + 1]).toBeLessThan(expected + BASE_MS);
    }
    expect(Math.max(...gaps)).toBeLessThan(REJOIN_MAX_WAIT_MS + BASE_MS);
    // The give-up line states the predicate the code actually measures, not a window the losses
    // need not have fallen inside.
    const logged = errors.mock.calls.map((c) => String(c[0])).join('\n');
    expect(logged).toContain('consecutive times, each within');
    expect(logged).toContain('not re-entering it again');
    await plugin.disconnect();
  }, 30_000);
});

// The README states the ladder in prose. Parse the numbers back out of it, so the sentence cannot
// keep advertising a wait the constants cannot produce.
describe('the README backoff sentence matches the constants', () => {
  it('quotes the first step, the top step, the jitter bound and the loss limit', () => {
    // Line wrapping is not the claim, so flatten it before reading the numbers out.
    const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8').replace(/\s+/g, ' ');
    const sentence = /deferred and backs off\*\*\s*\(([^)]*)\)/.exec(readme)?.[1];
    expect(sentence).toBeDefined();
    const numbers = [...(sentence as string).matchAll(/([\d.]+)\s*(ms|s)\b/g)].map(([, n, unit]) =>
      unit === 's' ? Number(n) * 1000 : Number(n),
    );
    // First step, top step, jitter bound — every number the ladder is built from.
    expect(numbers).toEqual([BASE_MS, REJOIN_MAX_WAIT_MS, BASE_MS]);
    expect(readme).toContain(`After ${LOSSES} consecutive losses, each within a minute`);
  });
});
