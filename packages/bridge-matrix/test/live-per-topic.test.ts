import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { MatrixPlugin } from '../src/index.js';
import {
  A,
  type Account,
  aliasForTopic,
  B,
  HOMESERVER,
  isMatrixUp,
  mxid,
  retireRoom,
  SERVER_NAME,
  tokenFor,
} from './live-gate.js';

/**
 * CLASS: the live suite must exercise the configuration the README calls production — one room per
 * topic (`shared_room` UNSET), with a DISTINCT Matrix account per session. `conformance.test.ts`
 * runs exclusively in `shared_room` mode with one account, which is the mode the README says MUST
 * NOT be used in production, and which structurally cannot observe anything about joining a room
 * another account created. Every room this plugin provisions is invite-only, so that join is the
 * whole multi-session story.
 *
 * Deliberately small (one room per case, two accounts) rather than a second full conformance
 * context: Synapse rate-limits room CREATION at ~2-room burst per user, and the frozen suite needs
 * ~7 fresh topics.
 */

/** One room per topic — `shared_room` deliberately unset, unlike the conformance fixture. */
const configFor = (account: Account, invite: string[]) => ({
  homeserver_url: HOMESERVER,
  server_name: SERVER_NAME,
  user: account.user,
  password: account.password,
  invite,
  sync_timeout_ms: 5000,
});

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const freshTopic = (prefix: string): Topic =>
  asTopic(`${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`);

/** Both accounts' tokens — the gate AND what {@link retireRoom} needs to unjoin them afterwards. */
const tokens = (await isMatrixUp())
  ? [await tokenFor(A), await tokenFor(B)].filter((t): t is string => t !== undefined)
  : [];
const bothAccounts = tokens.length === 2;

describe.skipIf(!bothAccounts)('live per-topic rooms, two accounts', () => {
  it('A creates the room inviting B; B posts, reads and receives live', async () => {
    const a = new MatrixPlugin();
    const b = new MatrixPlugin();
    const topic = freshTopic('per-topic-ok');
    try {
      await a.connect(configFor(A, [mxid(B.user)]));
      await b.connect(configFor(B, [mxid(A.user)]));

      await a.post(topic, asHandle('a'), 'from-a');

      const live: string[] = [];
      await b.subscribe(topic, (m) => live.push(m.content));
      await b.post(topic, asHandle('b'), 'from-b');

      const read = await b.fetchRecent({ topic, limit: 10 });
      expect(read.messages.map((m) => m.content)).toEqual(['from-a', 'from-b']);
      await expect
        .poll(() => live, { timeout: 15_000, interval: 100 })
        .toEqual(['from-b']);
    } finally {
      await retireRoom(aliasForTopic(String(topic)), tokens);
      await a.disconnect();
      await b.disconnect();
    }
  }, 60_000);

  /** The README's promise that an uninvited peer fails LOUDLY, on the real join rule. */
  it('A creates the room inviting nobody; every seam call by B names the fix', async () => {
    const a = new MatrixPlugin();
    const b = new MatrixPlugin();
    const topic = freshTopic('per-topic-locked');
    try {
      await a.connect(configFor(A, []));
      await b.connect(configFor(B, []));

      await a.post(topic, asHandle('a'), 'from-a');

      const named = new RegExp(
        `${escapeRe(aliasForTopic(String(topic)))}[\\s\\S]*${escapeRe(mxid(B.user))}`,
      );
      await expect(b.post(topic, asHandle('b'), 'from-b')).rejects.toThrow(named);
      await expect(b.fetchRecent({ topic, limit: 10 })).rejects.toThrow(named);
      await expect(b.subscribe(topic, () => undefined)).rejects.toThrow(named);
      expect([...(b as unknown as { liveTopics: Set<string> }).liveTopics]).toEqual([]);
    } finally {
      await retireRoom(aliasForTopic(String(topic)), tokens);
      await a.disconnect();
      await b.disconnect();
    }
  }, 60_000);
});
