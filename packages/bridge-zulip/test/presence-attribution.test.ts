/**
 * The README's "Multiple concurrent sessions" section makes claims about who a peer looks like on
 * this backend, and the presence roster keys peers by a message's SENDER. Zulip stamps the sender
 * from the authenticated bot, so `post`'s `identity` never reaches it — and the README says so.
 * These rows pin that observable against the two deployments the README describes, so the prose and
 * the wire cannot drift: a change that made `identity` survive would fail here and force the
 * paragraph to be rewritten.
 */
import { asHandle, asTopic } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { ZulipPlugin } from '../src/index.js';
import { rand, useZulip } from './harness.js';

const boot = useZulip();

const SESSIONS = [
  { handle: 'ctx-payments', bot: 'payments-bot@localhost' },
  { handle: 'ctx-reviews', bot: 'reviews-bot@localhost' },
];

const DEPLOYMENTS = [
  {
    name: 'every session sharing one bot',
    botFor: () => 'parley-bot@localhost',
    /** One entry, carrying the union of both sessions' reach — the merged phantom peer. */
    expectedSenders: ['parley-bot@localhost', 'parley-bot@localhost'],
  },
  {
    name: 'a distinct bot per session',
    botFor: (i: number) => SESSIONS[i]!.bot,
    /** Separate entries — but named after the BOTS, never after `identity.handle`. */
    expectedSenders: [SESSIONS[0]!.bot, SESSIONS[1]!.bot],
  },
];

describe('zulip attributes every post to the authenticated bot, not to identity.handle', () => {
  for (const deployment of DEPLOYMENTS) {
    it(`reports bot emails as the roster key with ${deployment.name}`, async () => {
      const { fake } = await boot({
        members: SESSIONS.map((s, i) => ({ user_id: 20 + i, email: s.bot, full_name: s.handle })),
        credentials: [
          { email: 'parley-bot@localhost', apiKey: 'per-session-key' },
          ...SESSIONS.map((session) => ({ email: session.bot, apiKey: 'per-session-key' })),
          { email: 'reader@localhost', apiKey: 'k' },
        ],
      });
      const topic = asTopic(`presence-${rand()}`);

      for (const [i, session] of SESSIONS.entries()) {
        const plugin = new ZulipPlugin();
        await plugin.connect({
          site_url: fake.url,
          email: deployment.botFor(i),
          api_key: 'per-session-key',
        });
        await plugin.post(topic, asHandle(session.handle), `beat from ${session.handle}`);
        await plugin.disconnect();
      }

      const reader = new ZulipPlugin();
      await reader.connect({ site_url: fake.url, email: 'reader@localhost', api_key: 'k' });
      const { messages } = await reader.fetchRecent({ topic });
      await reader.disconnect();

      expect(messages.map((m) => m.senderHandle)).toEqual(deployment.expectedSenders);
      // …and NONE of the configured handles is discoverable, whichever deployment you pick.
      const handles = new Set(messages.map((m) => m.senderHandle));
      expect(SESSIONS.filter((s) => handles.has(asHandle(s.handle)))).toEqual([]);
    });
  }
});
