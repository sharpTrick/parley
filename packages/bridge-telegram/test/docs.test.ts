import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { type FakeTelegram, startFakeTelegram } from './fake-telegram.js';

const SENDER = asHandle('me');
const here = fileURLToPath(new URL('.', import.meta.url));
const source = readFileSync(join(here, '..', 'src', 'index.ts'), 'utf8');
const readme = readFileSync(join(here, '..', 'README.md'), 'utf8');
const pkg = JSON.parse(readFileSync(join(here, '..', 'package.json'), 'utf8')) as {
  description: string;
};

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

async function connected(): Promise<{ fake: FakeTelegram; plugin: TelegramPlugin }> {
  const fake = await startFakeTelegram();
  const dir = mkdtempSync(join(tmpdir(), 'parley-tg-docs-'));
  cleanups.push(async () => {
    await fake.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const plugin = new TelegramPlugin();
  await plugin.connect({
    token: fake.token,
    api_url: fake.url,
    store_path: join(dir, 'store.jsonl'),
    poll_timeout_s: 1,
  });
  cleanups.push(() => plugin.disconnect());
  return { fake, plugin };
}

const configTable = /## Config \(`backend_config`\)([\s\S]*?)\n## /.exec(readme)?.[1] ?? '';
const cursorRow = readme.split('\n').find((l) => l.startsWith('| `cursor`')) ?? '';
const declaredKeys = [
  ...(/export interface TelegramBackendConfig \{([\s\S]*?)\n\}/.exec(source)?.[1] ?? '').matchAll(
    /^ {2}(\w+)\??:/gm,
  ),
].map((m) => m[1] as string);

/**
 * Shipped metadata is read by people who will never open the source: the npm page, the README
 * table, DESIGN's backend row. Each claim below is checked against the strings the plugin actually
 * produces, so drift is a failing test rather than an integrator's wasted afternoon.
 */
describe('telegram shipped metadata matches the seam mapping', () => {
  const SURFACES = [
    { name: 'the npm description', text: () => pkg.description },
    { name: 'the README cursor row', text: () => cursorRow },
    {
      name: 'the DESIGN backend-cursor row',
      text: () => {
        const design = readFileSync(join(here, '..', '..', '..', 'DESIGN.md'), 'utf8');
        const row = /\n {2}- Telegram → ([\s\S]*?)\n {2}- Slack/.exec(design)?.[1] ?? '';
        expect(row).not.toBe('');
        return row;
      },
    },
  ];

  it.each(SURFACES)('$name names the observation sequence as the cursor', ({ text }) => {
    const claim = text();
    expect(claim.toLowerCase()).toContain('observation sequence');
    expect(claim).not.toMatch(/message_id`?\s*(=|→)\s*cursor/i);
  });

  it('and the cursor a fetched message carries really is the sequence, not its message_id', async () => {
    const { plugin } = await connected();
    // A first chat consumes sequences 1 and 2, so the second chat's message_id (1) and its
    // cursor (3) cannot coincide — a plugin returning either one would otherwise look identical.
    const first = asTopic('-1009850001');
    await plugin.post(first, SENDER, 'x');
    await plugin.post(first, SENDER, 'y');
    const topic = asTopic('-1009850002');
    const id = await plugin.post(topic, SENDER, 'z');

    const message = (await plugin.fetchRecent({ topic })).messages[0];
    expect(message?.backendMsgId).toBe(id);
    const messageId = (id as string).split(':')[1];
    expect(messageId).toBe('1');
    expect(message?.cursor).toBe('3');
    expect(message?.cursor).not.toBe(messageId);
  }, 20_000);
});

/**
 * A config key names the unit it bounds. `observed_retention_per_topic` did not — it bounds
 * records per CHAT, and `chat_map` can give one chat two topic names — which the README table had
 * to silently correct in prose. Lint the whole table so the next key cannot repeat it.
 */
describe('telegram config keys name the unit they bound', () => {
  const rowFor = (key: string): string =>
    configTable.split('\n').find((l) => l.startsWith(`| \`${key}\``)) ?? '';

  it('documents exactly the keys TelegramBackendConfig accepts', () => {
    expect(declaredKeys.length).toBeGreaterThan(0);
    const documented = [...configTable.matchAll(/^\| `(\w+)`/gm)].map((m) => m[1]);
    expect([...documented].sort()).toEqual([...declaredKeys].sort());
  });

  const UNITS = [
    { suffix: '_per_chat', requires: /per chat/i, forbids: /per topic/i },
    { suffix: '_per_topic', requires: /per topic/i, forbids: /per chat/i },
    { suffix: '_ms', requires: /\bms\b|milliseconds/i, forbids: null },
    { suffix: '_s', requires: /seconds/i, forbids: null },
  ];

  it.each(declaredKeys)('%s', (key) => {
    const row = rowFor(key);
    expect(row).not.toBe('');
    // A deprecated spelling's job is to point at the key that replaced it, not to state a unit.
    if (/deprecated/i.test(row)) {
      const replacement = declaredKeys.find((k) => k !== key && row.includes(`\`${k}\``));
      expect(replacement).toBeDefined();
      return;
    }
    for (const unit of UNITS) {
      if (!key.endsWith(unit.suffix)) continue;
      expect(row).toMatch(unit.requires);
      if (unit.forbids !== null) expect(row).not.toMatch(unit.forbids);
    }
  });

  it.each([
    { key: 'observed_retention_per_chat', config: { observed_retention_per_chat: 2 }, kept: 2 },
    { key: 'observed_retention_per_topic (deprecated)', config: { observed_retention_per_topic: 3 }, kept: 3 },
    {
      key: 'both, the current key wins',
      config: { observed_retention_per_chat: 2, observed_retention_per_topic: 5 },
      kept: 2,
    },
  ])('$key bounds retention per chat', async ({ config, kept }) => {
    const fake = await startFakeTelegram();
    const dir = mkdtempSync(join(tmpdir(), 'parley-tg-keys-'));
    cleanups.push(async () => {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const plugin = new TelegramPlugin();
    await plugin.connect({
      token: fake.token,
      api_url: fake.url,
      store_path: join(dir, 'store.jsonl'),
      poll_timeout_s: 1,
      ...config,
    });
    cleanups.push(() => plugin.disconnect());

    const topic = asTopic('-1009860001');
    for (let i = 0; i < 8; i++) await plugin.post(topic, SENDER, `m${i}`);
    const page = await plugin.fetchRecent({ topic, limit: 100 });
    expect(page.messages).toHaveLength(kept);
  }, 20_000);
});

/**
 * Core enables presence by default on a topic (`parley-presence`) that is not a Telegram chat id,
 * and core's presence loop swallows the failure — so an operator gets an empty roster and no
 * explanation. The sibling SaaS plugins warn about this in their READMEs; either this one resolves
 * the default topic or it carries the same warning, and either way the plugin says something.
 */
describe('telegram default presence topic', () => {
  const DEFAULT_PRESENCE_TOPIC = 'parley-presence';

  it('is either resolvable or documented as needing configuration', async () => {
    vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    const { plugin } = await connected();
    const resolvable = await plugin
      .fetchRecent({ topic: asTopic(DEFAULT_PRESENCE_TOPIC) })
      .then(() => true)
      .catch(() => false);
    if (resolvable) return;
    const warning = /presence/i.test(readme) ? readme : '';
    expect(warning).toMatch(/presence\.enabled.*false|presence\.topic/is);
    expect(warning).toContain(DEFAULT_PRESENCE_TOPIC);
  }, 20_000);

  it('writes a diagnostic when a topic resolves to no chat, instead of failing silently', async () => {
    const stderr: string[] = [];
    vi.spyOn(process.stderr, 'write').mockImplementation((chunk: unknown) => {
      stderr.push(String(chunk));
      return true;
    });
    const { plugin } = await connected();
    await expect(
      plugin.fetchRecent({ topic: asTopic(DEFAULT_PRESENCE_TOPIC) }),
    ).rejects.toThrow(/not a Telegram chat id/);
    expect(stderr.join('')).toContain(DEFAULT_PRESENCE_TOPIC);
    expect(stderr.join('')).toMatch(/resolves to no Telegram chat/);
  }, 20_000);
});
