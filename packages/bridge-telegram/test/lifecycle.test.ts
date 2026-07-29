import { mkdtempSync, readdirSync, readlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { type FakeTelegram, KNOWN_CHANNEL, startFakeTelegram } from './fake-telegram.js';

const SENDER = asHandle('me');
const TOPIC = asTopic('-1009500001');

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  for (const c of cleanups.splice(0).reverse()) await c();
  vi.restoreAllMocks();
});

/** Descriptors this process currently holds on `path` — the store's append fd, if any leaked. */
function openFdsFor(path: string): number {
  return readdirSync('/proc/self/fd').filter((fd) => {
    try {
      return readlinkSync(`/proc/self/fd/${fd}`) === path;
    } catch {
      return false;
    }
  }).length;
}

/**
 * `connect` is not atomic: it verifies the token, resolves every `chat_map` entry and opens the
 * observed store across several awaits. A guard checked before the first of them is a TOCTOU —
 * a second `connect` slips through and opens a SECOND getUpdates consumer on a token Telegram
 * allows exactly one on, and a `disconnect` that lands mid-flight is overwritten by the connect
 * still in progress, leaving an instance that reports connected, refuses to reconnect and
 * ingests nothing. Each cell drives one interleaving and then pins the post-conditions.
 *
 * `hold` names the request the racing call lands inside; there is no await between resolving the
 * last chat and publishing the store, so `getChat` is also the store-open interleaving.
 */
describe('telegram lifecycle races', () => {
  interface Cell {
    name: string;
    hold: 'getMe' | 'getChat';
    /** Runs while `connect` is parked. Returns what the connect promise must do afterwards. */
    race(plugin: TelegramPlugin, fake: FakeTelegram, config: Record<string, unknown>): Promise<void>;
    connectSettles: 'fulfilled' | 'rejected';
    connectedAfter: boolean;
  }

  const CELLS: Cell[] = [
    {
      name: 'connect || connect',
      hold: 'getMe',
      race: async (plugin, _fake, config) => {
        await expect(plugin.connect(config)).rejects.toThrow(/already connected/);
      },
      connectSettles: 'fulfilled',
      connectedAfter: true,
    },
    {
      name: 'connect || connect, parked on a chat_map resolution',
      hold: 'getChat',
      race: async (plugin, _fake, config) => {
        await expect(plugin.connect(config)).rejects.toThrow(/already connected/);
      },
      connectSettles: 'fulfilled',
      connectedAfter: true,
    },
    {
      name: 'connect || disconnect',
      hold: 'getMe',
      race: async (plugin) => {
        await plugin.disconnect();
      },
      connectSettles: 'rejected',
      connectedAfter: false,
    },
    {
      name: 'connect || disconnect, parked on a chat_map resolution',
      hold: 'getChat',
      race: async (plugin) => {
        await plugin.disconnect();
      },
      connectSettles: 'rejected',
      connectedAfter: false,
    },
    {
      name: 'connect-fails || disconnect',
      hold: 'getMe',
      race: async (plugin, fake) => {
        fake.failMethod('getMe', { status: 401, description: 'Unauthorized' });
        await plugin.disconnect();
      },
      connectSettles: 'rejected',
      connectedAfter: false,
    },
  ];

  it.each(CELLS)(
    '$name leaves one poll loop, one store fd, and a reconnectable plugin',
    async ({ hold, race, connectSettles, connectedAfter }) => {
      const fake = await startFakeTelegram();
      const dir = mkdtempSync(join(tmpdir(), 'parley-tg-race-'));
      const storePath = join(dir, 'store.jsonl');
      cleanups.push(async () => {
        await fake.close();
        rmSync(dir, { recursive: true, force: true });
      });
      vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
      const config = {
        token: fake.token,
        api_url: fake.url,
        store_path: storePath,
        poll_timeout_s: 1,
        chat_map: { news: KNOWN_CHANNEL.username },
      };

      const plugin = new TelegramPlugin();
      cleanups.push(() => plugin.disconnect());
      const held = fake.holdMethod(hold);
      const connecting = plugin.connect(config);
      // The racing call must land while `connect` is parked mid-flight, not before it starts.
      await vi.waitFor(() => expect(fake.callCount(hold)).toBeGreaterThan(0), {
        timeout: 3000,
        interval: 5,
      });
      await race(plugin, fake, config);
      held.release();
      const settled = await Promise.allSettled([connecting]);
      expect(settled[0]?.status).toBe(connectSettles);

      if (connectedAfter) {
        await expect(plugin.post(TOPIC, SENDER, 'x')).resolves.toBeDefined();
        expect(openFdsFor(storePath)).toBe(1);
      } else {
        await expect(plugin.post(TOPIC, SENDER, 'x')).rejects.toThrow(/not connected/);
        expect(openFdsFor(storePath)).toBe(0);
      }

      // Exactly ONE getUpdates consumer: a quiet second at poll_timeout_s=1 costs one loop a
      // couple of calls, two loops twice that, and a disconnected plugin none at all.
      const before = fake.callCount('getUpdates');
      await new Promise((r) => setTimeout(r, 1500));
      const spent = fake.callCount('getUpdates') - before;
      expect(spent).toBeLessThanOrEqual(connectedAfter ? 4 : 0);
      if (connectedAfter) expect(spent).toBeGreaterThan(0);

      // Whatever happened, the instance is reusable: disconnect then connect must work.
      fake.failMethod('getMe', undefined);
      await plugin.disconnect();
      await expect(plugin.connect(config)).resolves.toBeUndefined();
      await expect(plugin.post(TOPIC, SENDER, 'after')).resolves.toBeDefined();
      expect(openFdsFor(storePath)).toBe(1);
      await plugin.disconnect();
      expect(openFdsFor(storePath)).toBe(0);
    },
    30_000,
  );

  /**
   * The plainest form of the same class, with no hold at all: two `connect`s issued in one turn.
   * Both used to fulfil, leaving two poll loops on one token and two stores on one file — with
   * only the winner's fd reachable for `disconnect` to close.
   */
  it('rejects the loser of two concurrent connects and leaks neither store', async () => {
    const fake = await startFakeTelegram();
    const dir = mkdtempSync(join(tmpdir(), 'parley-tg-race2-'));
    const storePath = join(dir, 'store.jsonl');
    cleanups.push(async () => {
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    });
    const config = { token: fake.token, api_url: fake.url, store_path: storePath, poll_timeout_s: 1 };
    const plugin = new TelegramPlugin();
    cleanups.push(() => plugin.disconnect());

    const settled = await Promise.allSettled([plugin.connect(config), plugin.connect(config)]);
    expect(settled.map((s) => s.status).sort()).toEqual(['fulfilled', 'rejected']);
    expect(openFdsFor(storePath)).toBe(1);

    const before = fake.callCount('getUpdates');
    await new Promise((r) => setTimeout(r, 1500));
    expect(fake.callCount('getUpdates') - before).toBeLessThanOrEqual(4);

    await plugin.disconnect();
    expect(openFdsFor(storePath)).toBe(0);
  }, 20_000);
});
