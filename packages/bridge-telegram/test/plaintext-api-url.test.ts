import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { captureStderr, registerCleanup, startFake, storePath } from './rig.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8');
const shippedDefault = /const DEFAULT_API_URL = '([^']+)'/.exec(source)?.[1] ?? '';

/**
 * `api_url` is a documented override (a local Bot API server), and on THIS API the credential rides
 * the URL **path** — so an `http://` base pointed anywhere but loopback puts the bot token in every
 * request line, in the clear, and in the logs of every proxy between here and there. That is
 * strictly worse than the header-borne case three sibling backends already warn about, and it used
 * to load in silence.
 *
 * One row per spelling a base URL can wear, because "is this loopback" is a PARSE and a prefix
 * match gets it wrong in both directions: `127.0.0.1.example.com` is a resolvable remote name that
 * merely looks like an address, and `[::1]` is loopback written in a form no `127.` test sees. The
 * warning must fire exactly when the credential would cross the network unencrypted — no more, no
 * less — and must never itself be the thing that prints a secret.
 */
const PASSWORD = 's3cret-in-the-url';

interface Row {
  name: string;
  /** Built from the fake's port when the row is meant to actually reach it. */
  url: (fakeUrl: string) => string;
  warns: boolean;
  /** Whether `connect` is expected to complete — only the rows aimed at the fake can. */
  reaches: boolean;
}

const ROWS: Row[] = [
  { name: 'the loopback fake by IP', url: (fake) => fake, warns: false, reaches: true },
  {
    name: 'the loopback fake by name',
    url: (fake) => fake.replace('127.0.0.1', 'localhost'),
    warns: false,
    reaches: true,
  },
  { name: 'IPv6 loopback', url: () => 'http://[::1]:1', warns: false, reaches: false },
  {
    name: 'a DNS name merely shaped like a loopback address',
    url: () => 'http://127.0.0.1.example.com:1',
    warns: true,
    reaches: false,
  },
  { name: 'a remote host over http', url: () => 'http://remote.example', warns: true, reaches: false },
  { name: 'a remote host over https', url: () => 'https://remote.example', warns: false, reaches: false },
  {
    name: 'a remote http host carrying userinfo',
    url: () => `http://bot:${PASSWORD}@remote.example`,
    warns: true,
    reaches: false,
  },
];

describe('telegram plaintext api_url', () => {
  it.each(ROWS)('$name warns: $warns', async ({ url, warns, reaches }) => {
    const stderr = captureStderr();
    const fake = await startFake();
    const apiUrl = url(fake.url);
    const plugin = new TelegramPlugin();
    registerCleanup(() => plugin.disconnect());

    const connected = await plugin
      .connect({ token: fake.token, api_url: apiUrl, store_path: storePath(), poll_timeout_s: 1 })
      .then(
        () => true,
        () => false,
      );
    expect(connected).toBe(reaches);

    const security = stderr.filter((l) => l.includes('SECURITY'));
    expect(security).toHaveLength(warns ? 1 : 0);
    if (!warns) return;
    // The ORIGIN, so an operator can tell which host it is — and only the origin, so a secret
    // smuggled into userinfo or a path is not what the warning itself prints.
    expect(security[0]).toContain(new URL(apiUrl).origin);
    expect(security[0]).not.toContain(PASSWORD);
    expect(security[0]).toMatch(/http:\/\/|plaintext/);
  }, 20_000);

  /**
   * The negative control the table cannot execute: an unconfigured bridge must not warn, and the
   * only way to run that row through `connect` is to let a test call the real Telegram API.
   */
  it('ships an https default, so an unconfigured bridge has nothing to warn about', () => {
    expect(shippedDefault).toMatch(/^https:\/\//);
  });
});
