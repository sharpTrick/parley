import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asHandle, asTopic, type Message } from '@sharptrick/parley-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { GAP_FILL_PAGE } from '../src/index.js';
import { MAX_MESSAGES_PER_FETCH, type ZulipMessage, zulipToMessage } from '../src/wire.js';
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
 * lands while the queue is dead reaches no queue at all, so recovery is a re-register plus a
 * PAGINATED gap-fill whose own history reads can fail — and a failure BETWEEN two delivered pages
 * is the case that grades the per-page progress watermark. The table crosses dead windows that
 * straddle the page boundary with where the failure lands, and asserts exactly-once by counting
 * DISTINCT ids against deliveries, so a duplicate fails instead of being absorbed by an
 * order-and-content comparison.
 *
 * A failure point is only generated for a window with enough pages to REACH it, and every row
 * asserts the fault it injected was actually served: a row whose precondition its own crossed
 * dimension cannot satisfy is a near-copy of "nothing" that pays full setup cost and grades nothing,
 * so it must fail rather than pass.
 */
describe('zulip queue GC recovery', () => {
  const DEAD_WINDOWS = [3, GAP_FILL_PAGE, GAP_FILL_PAGE + 100, 2 * GAP_FILL_PAGE + 1];

  /**
   * History reads a clean gap-fill of `window` messages issues: one per full page, plus a final read
   * that comes back short (empty when the window divides evenly into pages) and ends the walk.
   */
  const cleanReads = (window: number): number =>
    window % GAP_FILL_PAGE === 0 ? window / GAP_FILL_PAGE + 1 : Math.ceil(window / GAP_FILL_PAGE);

  const FAILURE_POINTS = [
    { name: 'nothing', after: 0, failsAfter: () => false },
    { name: 'the read after the 1st page', after: 1, failsAfter: (n: number) => n === 1 },
    { name: 'the read after the 2nd page', after: 2, failsAfter: (n: number) => n === 2 },
    // Arms after every odd read, so a window with more pages keeps re-arming as the walk resumes.
    { name: 'every other read', after: 1, failsAfter: (n: number) => n % 2 === 1 },
  ];

  for (const deadWindow of DEAD_WINDOWS) {
    // A failure armed after the LAST clean read fires on a read the gap-fill never issues.
    for (const point of FAILURE_POINTS.filter((p) => p.after < cleanReads(deadWindow))) {
      it(`replays ${deadWindow} dead-window message(s) exactly once with ${point.name} failing`, async () => {
        const { plugin, fake } = await boot();
        const topic = asTopic(`gc-${rand()}`);
        const got: Message[] = [];
        await plugin.subscribe(topic, (m) => got.push(m));

        await plugin.post(topic, SENDER, 'before');
        await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 5000, interval: 10 });

        // Kill every queue server-side, then fill the dead window: those messages reach no queue
        // and can only arrive via the retried, paginated gap-fill.
        fake.expireQueues();
        const expected = ['before'];
        for (let i = 0; i < deadWindow; i++) {
          expected.push(`d${i}`);
          fake.injectMessage({ topic, content: `d${i}` });
        }
        // Injecting the failure from the response hook lands it BETWEEN delivered pages, which
        // `failMessagesReads` alone cannot do — it only ever fails reads before the first page.
        let reads = 0;
        fake.setResponseHook((route) => {
          if (route !== 'GET /api/v1/messages') return;
          reads++;
          if (point.failsAfter(reads)) fake.failNextMessagesRead();
        });

        await vi.waitFor(() => expect(got).toHaveLength(expected.length), {
          timeout: 30_000,
          interval: 10,
        });
        fake.setResponseHook(undefined);
        await sleep(400);

        expect(got.map((m) => m.content)).toEqual(expected);
        expect(new Set(got.map((m) => m.backendMsgId)).size).toBe(got.length);
        expect(fake.servedMessagesReadFailures() > 0).toBe(point.after > 0);
      }, 60_000);
    }
  }

  /**
   * A dead window can be a whole page of records the plugin cannot use — their `id` is both its dedup
   * key and its cursor. Dropping them all must still walk the anchor past them, or the gap-fill
   * reports the gap CLOSED at the old watermark and everything behind them is never pushed and never
   * retried. No `limit`-based read case can reach this: only the gap-fill sizes its own page.
   */
  it('replays what is behind a full page of unusable records in the dead window', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { plugin, fake } = await boot();
    const topic = asTopic(`gc-unusable-${rand()}`);
    const got: Message[] = [];
    await plugin.subscribe(topic, (m) => got.push(m));

    await plugin.post(topic, SENDER, 'before');
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 5000, interval: 10 });

    fake.expireQueues();
    for (let i = 0; i < GAP_FILL_PAGE; i++) fake.injectRaw({ topic, fields: { id: 1.5 + i } });
    const behind = ['u0', 'u1', 'u2'];
    for (const content of behind) fake.injectMessage({ topic, content });

    await vi.waitFor(() => expect(got.map((m) => m.content)).toEqual(['before', ...behind]), {
      timeout: 30_000,
      interval: 10,
    });
  }, 60_000);

  /**
   * The page EDGE is the position that decides whether the walk can continue at all: the anchor for
   * the next page is taken from there, so a record the client cannot name sitting exactly on it
   * leaves the walk with nowhere to go. On this path that is permanent — a short page reads as a
   * closed gap, `needsGapFillFrom` is cleared, and everything behind the record is never delivered
   * and never retried. No `limit`-based read reaches it: only the gap-fill sizes its own page, so
   * only here can a record be placed on the boundary of one.
   */
  it('replays what is behind an unnameable record sitting on the gap-fill page edge', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { plugin, fake } = await boot();
    const topic = asTopic(`gc-edge-${rand()}`);
    // Kept unnameable by ASSERTION: a shape `zulipToMessage` happens to accept grades nothing here.
    const EDGE_ID = 'nope';
    expect(zulipToMessage(topic, { id: EDGE_ID } as unknown as ZulipMessage)).toBeUndefined();

    const got: Message[] = [];
    await plugin.subscribe(topic, (m) => got.push(m));
    await plugin.post(topic, SENDER, 'before');
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 5000, interval: 10 });

    // The dead window fills the first gap-fill page to one short, so the injected record lands on
    // the page boundary and the records behind it are only reachable by stepping over it.
    fake.expireQueues();
    const dead = Array.from({ length: GAP_FILL_PAGE - 1 }, (_, i) => `d${i}`);
    for (const content of dead) fake.injectMessage({ topic, content });
    fake.injectRaw({ topic, fields: { id: EDGE_ID } });
    const behind = ['b0', 'b1', 'b2'];
    for (const content of behind) fake.injectMessage({ topic, content });

    await vi.waitFor(
      () => expect(got.map((m) => m.content)).toEqual(['before', ...dead, ...behind]),
      { timeout: 30_000, interval: 20 },
    );
    expect(new Set(got.map((m) => m.backendMsgId)).size).toBe(got.length);
  }, 60_000);

  /**
   * The residual, pinned so it cannot regress into a silent one: a page in which NOT ONE record can
   * be named offers no id to continue from, and no widening or fallback can invent one. What must
   * NOT happen is the walk's dead stop being read as history running out — that clears
   * `needsGapFillFrom` and drops everything behind the obstruction permanently. It stays armed and
   * paced instead, so the hole is retried and reported rather than closed over.
   */
  it('keeps a gap that nothing can navigate armed, instead of reporting it closed', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { plugin, fake } = await boot();
    const topic = asTopic(`gc-blind-${rand()}`);
    const got: Message[] = [];
    await plugin.subscribe(topic, (m) => got.push(m));
    await plugin.post(topic, SENDER, 'before');
    await vi.waitFor(() => expect(got).toHaveLength(1), { timeout: 5000, interval: 10 });

    // Wider than one server page, so no widening can reach past it: the read may ask for at most
    // MAX_MESSAGES_PER_FETCH and every record it can get back carries no id to continue from.
    fake.expireQueues();
    const blind = MAX_MESSAGES_PER_FETCH + 1;
    for (let i = 0; i < blind; i++) fake.injectRaw({ topic, fields: { id: `x${i}` } });
    fake.injectMessage({ topic, content: 'behind' });

    const reads = fake.requestCount('GET /api/v1/messages');
    await vi.waitFor(
      () => expect(fake.requestCount('GET /api/v1/messages')).toBeGreaterThan(reads + 2),
      { timeout: 20_000, interval: 50 },
    );
    expect(got.map((m) => m.content)).toEqual(['before']);
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
 * The two passes below used to be copy-pasted context literals and had already drifted apart in the
 * long-poll cap. Guard the class, not that instance: a third transport or a second stream must go
 * through the shared factory rather than being pasted in here again.
 */
describe('zulip conformance passes share one context factory', () => {
  it('declares no conformance capability inline', () => {
    const source = readFileSync(fileURLToPath(import.meta.url), 'utf8');
    const inlineCapabilities = source
      .split('\n')
      .map((line, i) => ({ line: i + 1, text: line.trim() }))
      .filter((l) => /^(supportsBlockingFetch|carriesSenderIdentity|concurrentPost|freshTopic):/.test(l.text));
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
