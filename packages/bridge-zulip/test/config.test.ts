/**
 * Every `backend_config` value either works, or is rejected by `connect()` in terms that name the
 * key. The failure mode this table exists for is the third outcome: a value that is accepted and
 * then quietly ruins the run — a poll cap of `0` (what an operator writes to mean "no cap") turned
 * the push loop into a silent, unlogged request flood against their own server.
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import {
  DECLARED_CONFIG_KEYS,
  DECLARED_CONFIG_TYPES,
  rand,
  SENDER,
  sleep,
  useZulip,
} from './harness.js';
import { startFakeZulip, ZULIP_DEFAULT_RATE_LIMIT_PER_MIN } from './fake-zulip.js';

const boot = useZulip();

const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

/** The `events_timeout_ms` row of the README's config table — the claims below are read out of it. */
const CAP_DOC = /^\| `events_timeout_ms`\s*\|\s*`(\d+)`\s*\|(.*)$/m.exec(README);

/** The bounds the README publishes: `[floor, ceiling]` and the default. */
const DOCUMENTED_CAP = {
  defaultMs: Number(CAP_DOC?.[1]),
  floorMs: Number(/Clamped to `\[(\d+), \d+]`/.exec(CAP_DOC?.[2] ?? '')?.[1]),
};

/**
 * Requests one cap spends per subscribed topic: the parked poll, then the `dont_block=true` probe
 * that tells a healthy idle cap from a black-holed server. The README publishes this number because
 * an operator has to multiply by it; here it turns the poll cap into a RATE.
 */
const REQUESTS_PER_CAP = 2;

/** Requests a minute the documented bounds imply for `topics` subscribed topics at `capMs`. */
const documentedRatePerMin = (capMs: number, topics: number): number =>
  (topics * REQUESTS_PER_CAP * 60_000) / capMs;

/**
 * The published rate plus what an observation window cannot control: scheduling jitter (relative),
 * and the register handshake and the poll already in flight when the clock starts (a fixed few).
 * Keep the relative part tight, so that a THIRD request entering the cycle is still a failure —
 * a ceiling of twice the published rate is one no per-cap cost this side of doubling can fail.
 */
const rateCeiling = (expectedInWindow: number): number => Math.ceil(expectedInWindow * 1.25) + 2;

const observedCeiling = (topics: number, observeMs: number): number =>
  rateCeiling((documentedRatePerMin(DOCUMENTED_CAP.floorMs, topics) * observeMs) / 60_000);

/** A poll cap can only be called honest if this many requests cannot fit in the window. */
const OBSERVE_MS = 800;

interface ConfigRow {
  key: string;
  /** Literal value, or one derived from the live fake's URL. */
  value: unknown | ((url: string) => unknown);
  rejects: boolean;
}

const CONFIG_ROWS: ConfigRow[] = [
  { key: 'events_timeout_ms', value: 0, rejects: true },
  { key: 'events_timeout_ms', value: -1, rejects: true },
  { key: 'events_timeout_ms', value: Number.NaN, rejects: true },
  { key: 'events_timeout_ms', value: Number.POSITIVE_INFINITY, rejects: true },
  { key: 'events_timeout_ms', value: '25000', rejects: true },
  { key: 'events_timeout_ms', value: null, rejects: true },
  { key: 'events_timeout_ms', value: 0.5, rejects: false },
  { key: 'events_timeout_ms', value: 1, rejects: false },
  { key: 'events_timeout_ms', value: 250, rejects: false },
  { key: 'events_timeout_ms', value: 500, rejects: false },
  { key: 'events_timeout_ms', value: Number.MAX_SAFE_INTEGER, rejects: false },
  { key: 'site_url', value: '', rejects: true },
  { key: 'site_url', value: 'not-a-url', rejects: true },
  { key: 'site_url', value: '   ', rejects: true },
  { key: 'site_url', value: 'ftp://zulip.example.com', rejects: true },
  { key: 'site_url', value: 42, rejects: true },
  { key: 'site_url', value: null, rejects: true },
  { key: 'site_url', value: (url: string) => `${url}/`, rejects: false },
  { key: 'site_url', value: (url: string) => `${url}//`, rejects: false },
  { key: 'stream', value: '', rejects: true },
  { key: 'stream', value: '   ', rejects: true },
  { key: 'stream', value: 42, rejects: true },
  { key: 'stream', value: null, rejects: true },
  { key: 'stream', value: 'parley', rejects: false },
  { key: 'email', value: '', rejects: true },
  { key: 'api_key', value: '', rejects: true },
];

describe('zulip backend_config: no value is accepted into a hot loop or a deferred crash', () => {
  for (const row of CONFIG_ROWS) {
    const shown = typeof row.value === 'function' ? '<the fake url, decorated>' : String(row.value);
    it(`${row.key}: ${shown} ${row.rejects ? 'is rejected, naming the key' : 'runs a sane loop'}`, async () => {
      const fake = await startFakeZulip({ heartbeatMs: 5000 });
      const value = typeof row.value === 'function' ? row.value(fake.url) : row.value;
      const plugin = new ZulipPlugin();
      const config = { site_url: fake.url, [row.key]: value };
      try {
        if (row.rejects) {
          await expect(plugin.connect(config)).rejects.toThrow(row.key);
          return;
        }
        await plugin.connect(config);
        const topic = asTopic(`cfg-${rand()}`);
        const got: Message[] = [];
        await plugin.subscribe(topic, (m) => got.push(m));
        await sleep(OBSERVE_MS);
        expect(fake.requestCount('GET /api/v1/events')).toBeLessThanOrEqual(
          observedCeiling(1, OBSERVE_MS),
        );

        // Accepted means WORKING, not merely quiet: the push path must still deliver.
        await plugin.post(topic, SENDER, 'live');
        await sleep(400);
        expect(got.map((m) => m.content)).toEqual(['live']);
      } finally {
        await plugin.disconnect().catch(() => undefined);
        await fake.close();
      }
    });
  }
});

/**
 * CLASS: a config bound that is legal locally and illegal against the SERVER. What an idle push loop
 * costs is a RATE — {@link REQUESTS_PER_CAP} requests per cap per subscribed topic — and Zulip bills
 * it against a budget kept per USER, so a bound checked as "few enough requests in one window with
 * one topic" measures the wrong quantity entirely and no floor can fail it. These rows measure the
 * rate against the bounds the README publishes, in both dimensions the operator actually varies, so
 * a floor lowered, a request added to the cycle, or a README that drifts from either fails here
 * rather than in a deployment sitting in permanent 429 backoff.
 */
describe('the idle push loop costs what the README publishes', () => {
  it('publishes bounds these rows can be read from', () => {
    expect(DOCUMENTED_CAP.floorMs).toBeGreaterThan(0);
    expect(DOCUMENTED_CAP.defaultMs).toBeGreaterThan(DOCUMENTED_CAP.floorMs);
  });

  const RATE_OBSERVE_MS = 2400;
  /** Below the floor, at the floor, and above it — the clamp is a documented claim of its own. */
  const CAPS = [1, DOCUMENTED_CAP.floorMs, 1000];

  for (const capMs of CAPS) {
    for (const topics of [1, 4]) {
      it(`events_timeout_ms ${capMs} × ${topics} topic(s) stays inside the published rate`, async () => {
        const fake = await startFakeZulip({ heartbeatMs: 60_000 });
        const plugin = new ZulipPlugin();
        await plugin.connect({ site_url: fake.url, events_timeout_ms: capMs });
        try {
          for (let i = 0; i < topics; i++) {
            await plugin.subscribe(asTopic(`rate-${i}-${rand()}`), () => undefined);
          }
          const before = fake.requestCount('GET /api/v1/events');
          await sleep(RATE_OBSERVE_MS);
          const polls = fake.requestCount('GET /api/v1/events') - before;
          const effectiveCap = Math.max(capMs, DOCUMENTED_CAP.floorMs);
          const ceiling = rateCeiling(
            (documentedRatePerMin(effectiveCap, topics) * RATE_OBSERVE_MS) / 60_000,
          );
          // Both directions: a loop that stopped polling is not a loop that is cheap.
          expect([polls > 0, polls <= ceiling, { polls, ceiling }]).toEqual([
            true,
            true,
            { polls, ceiling },
          ]);
        } finally {
          await plugin.disconnect().catch(() => undefined);
          await fake.close();
        }
      }, 20_000);
    }
  }

  it(`the default cap leaves a session under Zulip's ${ZULIP_DEFAULT_RATE_LIMIT_PER_MIN}/min budget`, () => {
    const topics = 8;
    expect(documentedRatePerMin(DOCUMENTED_CAP.defaultMs, topics)).toBeLessThan(
      ZULIP_DEFAULT_RATE_LIMIT_PER_MIN,
    );
  });

  it('the README states the per-cap cost and the budget an operator multiplies against', () => {
    expect(CAP_DOC?.[2]).toContain(`\`${REQUESTS_PER_CAP}\``);
    expect(CAP_DOC?.[2]).toContain(`\`${ZULIP_DEFAULT_RATE_LIMIT_PER_MIN}\``);
  });
});

/**
 * CLASS: no key `backend_config` does not implement is accepted. A key the plugin never reads is a
 * silent no-op that takes the DEFAULT — for `api_key` the world-known built-in one, which then
 * authenticates every request against the operator's real server. The near misses are GENERATED
 * from the declared key set, so the rows widen with the config surface instead of pinning one typo.
 */
const NEAR_MISSES: Array<(key: string) => { name: string; typo: string }> = [
  (key) => ({ name: 'a dropped first character', typo: key.slice(1) }),
  (key) => ({ name: 'a dropped last character', typo: key.slice(0, -1) }),
  (key) => ({
    name: 'a transposed pair',
    typo: key.slice(0, -2) + (key.at(-1) ?? '') + (key.at(-2) ?? ''),
  }),
  (key) => ({ name: 'snake_case swapped for camelCase', typo: key.replace(/_(.)/g, (_m, c: string) => c.toUpperCase()) }),
  (key) => ({ name: 'a doubled character', typo: (key.at(0) ?? '') + key }),
];

/** A value that must never reach anything readable, whichever key it was mistyped into. */
const MISTYPED_SECRET = 'sup3r-s3cret-mistyped';

describe('zulip backend_config: a key the plugin does not implement is a load error', () => {
  for (const key of DECLARED_CONFIG_KEYS) {
    it(`every near miss of ${key} is rejected, naming the offending key`, async () => {
      const misses = NEAR_MISSES.map((make) => make(key)).filter(
        (m) => m.typo !== '' && !DECLARED_CONFIG_KEYS.includes(m.typo),
      );
      expect(misses.length).toBeGreaterThan(0);
      for (const { name, typo } of misses) {
        const attempt = new ZulipPlugin().connect({
          site_url: 'https://z.example.com',
          [typo]: MISTYPED_SECRET,
        });
        const err = await attempt.then(
          () => undefined,
          (e: unknown) => e as Error,
        );
        expect(err?.message, `${key}: ${name}`).toContain(typo);
        // The key is the whole diagnostic; its VALUE reaches stderr and model context.
        expect(err?.message, `${key}: ${name}`).not.toContain(MISTYPED_SECRET);
      }
    });
  }

  it('names the accepted set, and it is exactly the declared one', async () => {
    const err = await new ZulipPlugin()
      .connect({ site_url: 'https://z.example.com', nonsense: 1 })
      .then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    expect(err).toBeDefined();
    const named = DECLARED_CONFIG_KEYS.filter((k) => (err?.message ?? '').includes(k));
    expect(named).toEqual(DECLARED_CONFIG_KEYS);
  });

  it('an unknown key is refused before any other validation, and before a live connection is torn down', async () => {
    const fake = await startFakeZulip();
    const plugin = new ZulipPlugin();
    try {
      await plugin.connect({ site_url: fake.url });
      await expect(plugin.connect({ site_url: 'not-a-url', api_kye: 'x' })).rejects.toThrow(
        'api_kye',
      );
      const topic = asTopic(`survives-${rand()}`);
      await plugin.post(topic, SENDER, 'still connected');
      expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual([
        'still connected',
      ]);
    } finally {
      await plugin.disconnect().catch(() => undefined);
      await fake.close();
    }
  });
});

/**
 * CLASS: a README sentence that states the wrong failure TIME. Whether a misconfiguration is
 * refused at load or surfaces at the first request is the whole operator experience — one is a
 * bridge that never comes up, the other is a bridge that comes up and then fails a hand-off — and
 * a doc can state it wrongly while every behavioural test stays green. The keys are read out of the
 * README's own config table, so the claim widens with the documented surface rather than pinning
 * today's five, and both halves of the corrected sentence are graded: what `connect()` refuses, and
 * what it cannot possibly refuse because it never speaks to the server.
 */
const README_CONFIG_KEYS = [
  ...(/## Config \(`backend_config`\)([\s\S]*?)\n## /.exec(README)?.[1] ?? '').matchAll(
    /^\| `(\w+)`\s*\|/gm,
  ),
].map((m) => m[1] as string);

/** A value of the declared TYPE that no key can accept, so the rejection is about the key. */
const UNUSABLE_BY_TYPE: Record<string, unknown> = { string: '   ', number: 0 };

describe('zulip backend_config fails at the time the README says it does', () => {
  it('the config table documents exactly the keys the plugin declares', () => {
    expect(README_CONFIG_KEYS).toEqual(DECLARED_CONFIG_KEYS);
  });

  for (const key of README_CONFIG_KEYS) {
    it(`${key}: an unusable value is refused by connect(), not carried into the first call`, async () => {
      const fake = await startFakeZulip();
      const plugin = new ZulipPlugin();
      try {
        const unusable = UNUSABLE_BY_TYPE[DECLARED_CONFIG_TYPES[key] ?? ''];
        expect(unusable, `no unusable value declared for ${key}`).toBeDefined();
        await expect(plugin.connect({ site_url: fake.url, [key]: unusable })).rejects.toThrow(key);
        expect(fake.requestCount()).toBe(0);
      } finally {
        await plugin.disconnect().catch(() => undefined);
        await fake.close();
      }
    });
  }

  it('a well-formed config asks the server nothing, so a wrong host or key can only surface later', async () => {
    const fake = await startFakeZulip();
    const plugin = new ZulipPlugin();
    try {
      await plugin.connect({ site_url: fake.url, api_key: 'wrong-but-well-formed' });
      expect(fake.requestCount()).toBe(0);
      await expect(plugin.post(asTopic(`late-${rand()}`), SENDER, 'x')).rejects.toThrow('401');
    } finally {
      await plugin.disconnect().catch(() => undefined);
      await fake.close();
    }
  });
});

describe('zulip backend_config defaults', () => {
  it('an omitted backend_config connects and works against the default-shaped server', async () => {
    const { plugin } = await boot(undefined, { events_timeout_ms: undefined });
    const topic = asTopic(`def-${rand()}`);
    await plugin.post(topic, SENDER, 'x');
    expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual(['x']);
  });
});
