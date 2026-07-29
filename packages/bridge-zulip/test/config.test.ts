/**
 * Every `backend_config` value either works, or is rejected by `connect()` in terms that name the
 * key. The failure mode this table exists for is the third outcome: a value that is accepted and
 * then quietly ruins the run — a poll cap of `0` (what an operator writes to mean "no cap") turned
 * the push loop into a silent, unlogged request flood against their own server.
 */
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { rand, SENDER, sleep, useZulip } from './harness.js';
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

describe('zulip backend_config defaults', () => {
  it('an omitted backend_config connects and works against the default-shaped server', async () => {
    const { plugin } = await boot(undefined, { events_timeout_ms: undefined });
    const topic = asTopic(`def-${rand()}`);
    await plugin.post(topic, SENDER, 'x');
    expect((await plugin.fetchRecent({ topic })).messages.map((m) => m.content)).toEqual(['x']);
  });
});
