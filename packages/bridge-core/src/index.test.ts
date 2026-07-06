// Barrel-surface regression guard (CX-10 / work item 06 "barrel-trim").
//
// The public entry `@sharptrick/parley-core` is automated-semver surface: every symbol it
// re-exports is frozen by the release automation. This test pins the trimmed set (consumer-free
// internals that must NOT be public) and the kept seam/config/composition-root surface, so a
// future edit that re-adds an internal to the barrel fails loudly here.
//
// It is a test only — it does not re-export anything from the barrel.
import { describe, expect, it } from 'vitest';
import * as api from './index.js';

describe('public barrel surface', () => {
  // The eight consumer-free internals trimmed by item 06. These stay defined in their own
  // modules (engine/presence.ts, identity-filter.ts, transport/tools.ts) for in-package callers,
  // reached via relative imports — but must never be reachable through the public entry.
  const trimmed = [
    'buildToolDefs',
    'matchGlob',
    'filterHandles',
    'MAX_RECORD_TOPICS',
    'MAX_INSTANCE_ID_LEN',
    'encodePresence',
    'decodePresence',
    'computeRoster',
  ] as const;

  // A representative slice of the deliberate kept surface (seam, config, engine, presence
  // default/types, composition roots).
  const kept = [
    'registerTools',
    'DEFAULT_PRESENCE_TOPIC',
    'asTopic',
    'asHandle',
    'asBackendMsgId',
    'asCursor',
    'parseMentions',
    'buildMessage',
    'createStdioBridge',
    'buildBridge',
    'loadConfig',
    'parseConfig',
    'Allowlist',
    'SeenSet',
    'catchUpTopic',
    'catchUpAll',
  ] as const;

  it.each(trimmed)('does not re-export the trimmed internal %s', (name) => {
    expect(name in api).toBe(false);
    expect((api as Record<string, unknown>)[name]).toBeUndefined();
  });

  it.each(kept)('still re-exports the kept symbol %s', (name) => {
    expect(name in api).toBe(true);
    expect((api as Record<string, unknown>)[name]).toBeDefined();
  });
});
