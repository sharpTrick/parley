import { runConformanceSuite } from '@sharptrick/parley-conformance';
import { asTopic, type Topic } from '@sharptrick/parley-core';
import { openRig } from './rig.js';

let seq = 0;

async function makeContext() {
  const rig = await openRig();
  return {
    plugin: rig.plugin,
    // fetchRecent honors `blockMs` NATIVELY: a parked fetch is woken by the SHARED
    // ingest path (the one getUpdates loop, or an own post) through ingest() — no second
    // getUpdates consumer. Run the shared blocking-fetch case directly against the plugin.
    supportsBlockingFetch: true,
    // Supergroup-shaped chat ids, one fresh chat per test: the fake rejects anything real
    // Telegram would 400 on, and an unmapped topic is used as the chat id literal.
    freshTopic: (): Topic => asTopic(String(-1_002_000_000_000 - ++seq)),
    carriesSenderIdentity: false, // posts as the bot account; `identity` is informational
    cleanup: rig.close,
    // Keep concurrentPost 'unsupported', so that the multi-writer case does not open a second
    // getUpdates consumer on a token Telegram allows exactly one on (HTTP 409), or a second writer
    // on the one-process observed-message store. One telegram bridge per bot token (README).
    concurrentPost: 'unsupported' as const,
  };
}

// Always runs — the fake Bot API is in-process, no external server needed.
runConformanceSuite('telegram', makeContext);
