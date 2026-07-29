import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { BOT_IDENTITY, type FakeTelegram, startFakeTelegram } from './fake-telegram.js';

const SENDER = asHandle('me');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

async function connected(
  extra: Record<string, unknown> = {},
): Promise<{ fake: FakeTelegram; plugin: TelegramPlugin }> {
  const fake = await startFakeTelegram();
  const dir = mkdtempSync(join(tmpdir(), 'parley-tg-guar-'));
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
    ...extra,
  });
  cleanups.push(() => plugin.disconnect());
  return { fake, plugin };
}

/**
 * Behaviour this package states as a guarantee in its JSDoc and its README seam-mapping table but
 * that no test could fail on: prose is not a guarantee, and every row here was written by deleting
 * the implementing lines first and watching it go red.
 */
describe('telegram documented guarantees', () => {
  it('disconnect unparks a blocked fetchRecent instead of holding it for the full blockMs', async () => {
    const { plugin } = await connected();
    const topic = asTopic('-1009700001');
    await plugin.post(topic, SENDER, 'seed');
    const tail = (await plugin.fetchRecent({ topic })).nextCursor;

    const started = Date.now();
    const parked = plugin.fetchRecent({ topic, since: tail, blockMs: 8000 });
    await new Promise((r) => setTimeout(r, 100));
    await plugin.disconnect();

    const res = await parked;
    expect(Date.now() - started).toBeLessThan(3000);
    expect(res.messages).toEqual([]);
    expect(res.nextCursor).toBe(tail);
  }, 20_000);

  it('disconnect aborts the in-flight long poll rather than leaving it parked upstream', async () => {
    const { fake, plugin } = await connected({ poll_timeout_s: 20 });
    await vi.waitFor(() => expect(fake.parkedPolls()).toBe(1), { timeout: 5000, interval: 10 });

    await plugin.disconnect();
    await vi.waitFor(() => expect(fake.parkedPolls()).toBe(0), { timeout: 1000, interval: 10 });
  }, 20_000);

  it.each([
    { name: "the bot's own username", handle: BOT_IDENTITY.username, ref: String(BOT_IDENTITY.id) },
    { name: 'any other handle', handle: 'someone-else', ref: 'someone-else' },
  ])('resolveIdentity maps $name', async ({ handle, ref }) => {
    const { plugin } = await connected();
    const identity = await plugin.resolveIdentity(asHandle(handle));
    expect(identity).toEqual({ handle, backendRef: ref });
  }, 20_000);
});
