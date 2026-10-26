import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { MAX_MESSAGES_PER_FETCH } from '../src/wire.js';
import { startFakeZulip } from './fake-zulip.js';
import {
  decideIntegrationGate,
  type GateProbe,
  makeZulipContext,
  rand,
  SENDER,
  sleep,
  useZulip,
} from './harness.js';

const boot = useZulip();

/** The in-process fake — always available, so this suite always runs. */
const fakeServerPass = async (): ReturnType<ReturnType<typeof makeZulipContext>> => {
  const fake = await startFakeZulip();
  return makeZulipContext({
    connect: { site_url: fake.url, events_timeout_ms: 1000 },
    closeServer: () => fake.close(),
  })();
};

runConformanceSuite('zulip', fakeServerPass);

/**
 * Zulip GCs an idle event queue after ~10 minutes and then answers `BAD_EVENT_QUEUE_ID`. Whatever
 * lands while the queue is dead reaches no queue at all, and push is a SUBSET of the post-subscribe
 * tail — so the dead window is a gap the live path does not owe, and the next catch-up is what
 * closes it. What the relaxed contract still FORBIDS is a duplicate, and a re-register is the one
 * place this backend could produce one: the recovery mints a whole new queue and adopts its
 * `last_event_id`, so a fresh queue that carried anything the dead one had already delivered would
 * re-serve it through the same handler.
 */
describe('zulip queue GC recovery', () => {
  /**
   * Dead windows either side of a server page, so a recovery that tried to read history back would
   * have to paginate — and be visible here as a replay rather than as a gap.
   */
  const DEAD_WINDOWS = [0, 3, MAX_MESSAGES_PER_FETCH + 1];

  for (const deadWindow of DEAD_WINDOWS) {
    it(`resumes after ${deadWindow} dead-window message(s) without re-serving one`, async () => {
      const { plugin, fake } = await boot();
      const topic = asTopic(`gc-${rand()}`);
      const got: Message[] = [];
      await plugin.subscribe(topic, (m) => got.push(m));

      await plugin.post(topic, SENDER, 'before');
      await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 5000, interval: 10 });

      // Kill every queue server-side, then fill the dead window: those messages reach no queue.
      const registersBefore = fake.requestCount('POST /api/v1/register');
      fake.expireQueues();
      const dead = Array.from({ length: deadWindow }, (_unused, i) => `d${i}`);
      for (const content of dead) fake.injectMessage({ topic, content });

      // The replacement queue has to EXIST before the next post, or `after` lands in the dead
      // window too and the row grades a wider gap than the one it named.
      await vi.waitFor(
        () => expect(fake.requestCount('POST /api/v1/register')).toBeGreaterThan(registersBefore),
        { timeout: 30_000, interval: 10 },
      );
      await plugin.post(topic, SENDER, 'after');
      await vi.waitFor(() => expect(got.map((m) => m.content)).toContain('after'), {
        timeout: 30_000,
        interval: 10,
      });
      await sleep(400);

      // The gap is a gap, and nothing arrived twice — not `before` from the dead queue, and not a
      // dead-window message the recovery decided to replay.
      expect(got.map((m) => m.content)).toEqual(['before', 'after']);
      expect(new Set(got.map((m) => m.backendMsgId)).size).toBe(got.length);

      // …and the window the live path skipped is reachable, in order, from the cursor of the last
      // message it DID deliver before the queue died.
      const from = got[0]?.cursor;
      const reconciled = await plugin.fetchRecent({ topic, since: from, limit: 10_000 });
      expect(reconciled.messages.map((m) => m.content)).toEqual([...dead, 'after']);
    }, 60_000);
  }

  /**
   * The re-register itself, isolated: a fresh queue must not carry a single event the dead one
   * already handed over. Graded by driving the recovery repeatedly on a topic that keeps receiving,
   * so a queue that replayed even its own newest event shows up as a duplicate id rather than as a
   * one-off ordering wobble.
   */
  it('a re-registered queue never re-serves an event the dead one delivered', async () => {
    const { plugin, fake } = await boot();
    const topic = asTopic(`gc-dedup-${rand()}`);
    const got: Message[] = [];
    await plugin.subscribe(topic, (m) => got.push(m));

    const expected: string[] = [];
    for (const cycle of [0, 1, 2]) {
      const content = `c${cycle}`;
      expected.push(content);
      await plugin.post(topic, SENDER, content);
      await vi.waitFor(() => expect(got).toHaveLength(expected.length), {
        timeout: 30_000,
        interval: 10,
      });
      const registersBefore = fake.requestCount('POST /api/v1/register');
      fake.expireQueues();
      await vi.waitFor(
        () => expect(fake.requestCount('POST /api/v1/register')).toBeGreaterThan(registersBefore),
        { timeout: 30_000, interval: 10 },
      );
    }
    await sleep(400);
    expect(got.map((m) => m.content)).toEqual(expected);
    expect(new Set(got.map((m) => m.backendMsgId)).size).toBe(got.length);
  }, 60_000);

  /**
   * A history read that cannot be navigated — a page whose every record carries an id the client
   * cannot continue from — is a `fetchRecent` concern now that nothing replays history through the
   * live handler. It must not silently become an empty topic: the read stops and says so, and the
   * live path is unaffected by it.
   */
  it('a page of records nothing can be named from stops the read instead of emptying the topic', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { plugin, fake } = await boot();
    const topic = asTopic(`blind-${rand()}`);
    const got: Message[] = [];
    await plugin.subscribe(topic, (m) => got.push(m));

    await plugin.post(topic, SENDER, 'before');
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 5000, interval: 10 });
    const from = got[0]?.cursor;

    // Wider than one server page, so no widening can reach past it.
    for (let i = 0; i < MAX_MESSAGES_PER_FETCH + 1; i++) {
      fake.injectRaw({ topic, fields: { id: `x${i}` } });
    }
    fake.injectMessage({ topic, content: 'behind' });

    const page = await plugin.fetchRecent({ topic, since: from, limit: 10_000 });
    expect(page.messages).toEqual([]);
    expect(warn.mock.calls.flat().join(' ')).toMatch(/cannot be reached/);
    // The live path went on serving throughout: the obstruction is in history, not in the queue —
    // `behind` reached the queue and was pushed even though no read can page past the block.
    await plugin.post(topic, SENDER, 'after');
    await vi.waitFor(
      () => expect(got.map((m) => m.content)).toEqual(['before', 'behind', 'after']),
      { timeout: 10_000, interval: 10 },
    );
  }, 60_000);
});

describe('zulip resolveIdentity', () => {
  it('maps email or full_name to the Zulip user_id, and misses to the string convention', async () => {
    const { plugin } = await boot();
    expect(await plugin.resolveIdentity(asHandle('parley-bot@localhost'))).toEqual({
      handle: 'parley-bot@localhost',
      backendRef: '10',
    });
    expect(await plugin.resolveIdentity(asHandle('Pat Sharp'))).toEqual({
      handle: 'Pat Sharp',
      backendRef: '11',
    });
    expect(await plugin.resolveIdentity(asHandle('nobody'))).toEqual({
      handle: 'nobody',
      backendRef: 'nobody',
    });
  });
});

/**
 * The two passes below used to be copy-pasted context literals and had already drifted apart.
 * Guard the class, not that instance: a third transport or a second stream must go through the
 * shared factory rather than being pasted in here again.
 */
describe('zulip conformance passes share one context factory', () => {
  it('declares no conformance capability inline', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const inlineCapabilities = source
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter((l) => /^(carriesSenderIdentity|concurrentPost|freshTopic):/.test(l.text));
    expect(inlineCapabilities).toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Optional second run against a REAL Zulip server. Fresh topics in the configured stream are
// free, so no scratch cleanup is needed beyond disconnect.
const REAL_URL = process.env.PARLEY_ZULIP_URL;
const REAL_EMAIL = process.env.PARLEY_ZULIP_EMAIL;
const REAL_KEY = process.env.PARLEY_ZULIP_API_KEY;
const REAL_STREAM = process.env.PARLEY_ZULIP_STREAM ?? 'parley';

async function probeZulip(url: string, email: string, key: string): Promise<GateProbe> {
  try {
    const res = await fetch(`${url.replace(/\/+$/, '')}/api/v1/users`, {
      headers: { Authorization: `Basic ${Buffer.from(`${email}:${key}`).toString('base64')}` },
      signal: AbortSignal.timeout(3000),
    });
    return { ok: res.ok, detail: `${res.status} ${res.statusText}` };
  } catch (err: unknown) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

const realVars = {
  PARLEY_ZULIP_URL: REAL_URL,
  PARLEY_ZULIP_EMAIL: REAL_EMAIL,
  PARLEY_ZULIP_API_KEY: REAL_KEY,
};
const allRealVarsSet = REAL_URL !== undefined && REAL_EMAIL !== undefined && REAL_KEY !== undefined;
const gate = decideIntegrationGate(
  realVars,
  allRealVarsSet ? await probeZulip(REAL_URL, REAL_EMAIL, REAL_KEY) : undefined,
);

if (gate.kind === 'run') {
  runConformanceSuite(
    'zulip (real)',
    makeZulipContext({
      connect: {
        site_url: REAL_URL,
        email: REAL_EMAIL,
        api_key: REAL_KEY,
        stream: REAL_STREAM,
        events_timeout_ms: 1000,
      },
    }),
  );
} else if (gate.kind === 'fail') {
  describe('seam conformance: zulip (real)', () => {
    it('runs against the configured PARLEY_ZULIP_* server', () => {
      expect.fail(gate.reason);
    });
  });
}
// A `skip` decision registers nothing at all. Keep it absent rather than a skipped placeholder, so
// that CI's gate can read every skipped group as coverage something took away: this pass runs by
// hand against a hosted Zulip, and no CI run was ever going to hold those credentials.
