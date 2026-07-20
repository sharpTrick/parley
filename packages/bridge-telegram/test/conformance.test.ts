import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asTopic, type Topic } from '@sharptrick/parley-core';
import { TelegramPlugin } from '../src/index.js';
import { startFakeTelegram } from './fake-telegram.js';

let seq = 0;
const rand = () => Math.random().toString(36).slice(2, 8);

async function makeContext() {
  const fake = await startFakeTelegram();
  const dir = mkdtempSync(join(tmpdir(), 'parley-tg-'));
  const plugin = new TelegramPlugin();
  await plugin.connect({
    token: 'test-token',
    api_url: fake.url,
    store_path: join(dir, 'store.jsonl'),
    poll_timeout_s: 1,
  });
  return {
    plugin,
    // fetchRecent honors `blockMs` NATIVELY (issue #20): a parked fetch is woken by the SHARED
    // ingest path (the one getUpdates loop, or an own post) through ingest() — no second
    // getUpdates consumer. Run the shared blocking-fetch case directly against the plugin.
    supportsBlockingFetch: true,
    // An unmapped topic is used as the chat id literal — a fresh chat per test.
    freshTopic: (): Topic => asTopic(`chat-${++seq}-${rand()}`),
    cleanup: async () => {
      await plugin.disconnect();
      await fake.close();
      rmSync(dir, { recursive: true, force: true });
    },
    // NO concurrentPost, deliberately: Telegram allows exactly ONE getUpdates consumer per
    // bot token (a second poller gets HTTP 409) and the observed-message store is one file
    // per process — multi-instance writers are structurally unrepresentable on this backend,
    // so conformance case 6 skips. Run exactly one telegram bridge per bot token (README).
  };
}

// Always runs — the fake Bot API is in-process, no external server needed.
runConformanceSuite('telegram', makeContext);
