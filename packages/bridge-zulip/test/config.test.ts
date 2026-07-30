/**
 * Every `backend_config` value either works, or is rejected by `connect()` in terms that name the
 * key. The failure mode this table exists for is the third outcome: a value that is accepted and
 * then quietly ruins the run — a poll cap of `0` (what an operator writes to mean "no cap") turned
 * the push loop into a silent, unlogged request flood against their own server.
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { DECLARED_CONFIG_KEYS, rand, SENDER, sleep, useZulip } from './harness.js';
import { startFakeZulip } from './fake-zulip.js';

const boot = useZulip();

/** A poll cap can only be called honest if this many requests cannot fit in the window. */
const OBSERVE_MS = 800;
const SANE_REQUEST_CEILING = 20;

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
        expect(fake.requestCount('GET /api/v1/events')).toBeLessThan(SANE_REQUEST_CEILING);

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

describe('zulip backend_config defaults', () => {
  it('an omitted backend_config connects and works against the default-shaped server', async () => {
    const { plugin } = await boot(undefined, { events_timeout_ms: undefined });
    const topic = asTopic(`def-${rand()}`);
    await plugin.post(topic, SENDER, 'x');
    expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual(['x']);
  });
});
