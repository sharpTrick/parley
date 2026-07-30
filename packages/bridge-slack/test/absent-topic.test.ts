/**
 * CLASS: a backend's absent-topic errors must map onto the seam's absent-topic contract, and
 * nothing else may. Core distinguishes "topic not present yet" (`NoSuchTopicError` — a normal
 * result, e.g. an empty presence roster) from a real backend failure (propagates). Slack signals
 * absence with `ok:false, error:'channel_not_found'`, which the generic `ok:false → Error` path
 * flattens into an indistinguishable failure — so a default deployment whose presence topic is not
 * a real channel id hard-fails `parley_list_users` instead of returning the empty roster.
 */
import { asCursor, asHandle, asTopic, NoSuchTopicError, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import type { SlackPlugin } from '../src/index.js';
import { withSlack } from './harness.js';

/**
 * `subscribe` is an op here because it is the one seam call that can report success and then deliver
 * nothing forever: Socket Mode says nothing about whether a channel exists or is readable, so a
 * typo'd `channel_map` target or a channel the bot was never invited to would otherwise resolve and
 * go silent — while `fetchRecent` on the SAME topic correctly reports absence, and core's "topic
 * does not exist yet" branch never runs. Every future absence code has to state its `subscribe`
 * answer alongside the others.
 *
 * The probe is a `conversations.history` read, so it detects exactly those two absences and NOT the
 * third way a subscription goes silent — an app whose Event Subscriptions lack `message.channels`
 * reads history perfectly and is pushed nothing. That gap is stated as a row below rather than left
 * to prose, and it is why a blocked `fetchRecent` keeps re-reading history on its ladder instead of
 * trusting an established socket (`blocking-fetch.test.ts`).
 */
type Op = 'fetchRecent' | 'fetchRecent-since' | 'post' | 'subscribe';

/** code → the ops for which it means "the topic is not there for us". */
const CODES: Array<{ code: string; absentFor: Op[] }> = [
  { code: 'channel_not_found', absentFor: ['fetchRecent', 'fetchRecent-since', 'post', 'subscribe'] },
  { code: 'not_in_channel', absentFor: ['fetchRecent', 'fetchRecent-since', 'subscribe'] },
  { code: 'is_archived', absentFor: [] },
  { code: 'invalid_auth', absentFor: [] },
  { code: 'ratelimited', absentFor: [] },
];

const OPS: Op[] = ['fetchRecent', 'fetchRecent-since', 'post', 'subscribe'];
const METHOD_OF: Record<Op, string> = {
  fetchRecent: 'conversations.history',
  'fetchRecent-since': 'conversations.history',
  post: 'chat.postMessage',
  subscribe: 'conversations.history',
};

async function run(plugin: SlackPlugin, op: Op): Promise<void> {
  const topic = asTopic('C0ABSENT');
  if (op === 'post') {
    await plugin.post(topic, asHandle('writer'), 'hello');
    return;
  }
  if (op === 'subscribe') {
    await plugin.subscribe(topic, () => undefined);
    return;
  }
  await plugin.fetchRecent(
    op === 'fetchRecent' ? { topic } : { topic, since: asCursor('0') },
  );
}

describe('slack absent-topic semantics', () => {
  for (const { code, absentFor } of CODES) {
    for (const op of OPS) {
      const absent = absentFor.includes(op);
      it(`${op} on ${code} → ${absent ? 'NoSuchTopicError' : 'a plain Error'}`, async () => {
        await withSlack({ channels: ['C0ABSENT'] }, async (fake, plugin) => {
          fake.failMethod(METHOD_OF[op], code);
          const err = await run(plugin, op).then(
            () => undefined,
            (e: unknown) => e,
          );
          expect(err).toBeInstanceOf(Error);
          expect(err instanceof NoSuchTopicError).toBe(absent);
          if (!absent) expect(String(err)).toContain(code);
        });
      });
    }
  }

  // The negative control the table above cannot state: a REACHABLE topic must not be refused by the
  // reachability probe, and must still deliver live. Without this, mapping every code to absent —
  // or rejecting every subscribe outright — would pass every row.
  it('subscribe on a reachable channel resolves and still delivers live', async () => {
    const topic = asTopic('C0REACHABLE');
    await withSlack({ channels: [topic] }, async (_fake, plugin) => {
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));
      await plugin.post(topic, asHandle('writer'), 'delivered');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toEqual(['delivered']), {
        timeout: 3000,
        interval: 10,
      });
    });
  });

  // DECLARED GAP: history readable, no events subscribed. The probe passes, subscribe resolves, and
  // the live path delivers nothing at all — catch-up is the only path that recovers those messages.
  // Stated as a row so the decision is reviewable, and so a probe that later grew a deliverability
  // check has to come here and change it.
  it('subscribe on a channel that is readable but pushes no events resolves, and only catch-up delivers', async () => {
    const topic = asTopic('C0NOEVENTS');
    await withSlack({ channels: [topic] }, async (fake, plugin) => {
      const live: Message[] = [];
      await plugin.subscribe(topic, (m) => live.push(m));
      // Durable in history, never pushed — exactly what a missing `message.channels` subscription
      // looks like from this side of the socket.
      fake.seed(topic, [{ text: 'durable but unpushed' }]);

      await new Promise((r) => setTimeout(r, 300));
      expect(live, 'the live path cannot see it').toEqual([]);
      const { messages } = await plugin.fetchRecent({ topic, limit: 10 });
      expect(messages.map((m) => m.content)).toEqual(['durable but unpushed']);
    });
  });

  // A channel id that was NEVER created is the everyday shape of the defect — a `channel_map` typo —
  // and reaches the plugin as the vendor's own `channel_not_found` rather than an injected failure.
  it('subscribe on a channel that does not exist rejects, and registers no route', async () => {
    const missing = asTopic('C0TYPO');
    const real = asTopic('C0REAL');
    await withSlack({ channels: [real] }, async (fake, plugin) => {
      const live: Message[] = [];
      await expect(plugin.subscribe(missing, (m) => live.push(m))).rejects.toBeInstanceOf(
        NoSuchTopicError,
      );
      // Both delivery paths must agree that the topic is absent — the asymmetry IS the defect.
      await expect(plugin.fetchRecent({ topic: missing })).rejects.toBeInstanceOf(NoSuchTopicError);
      // A rejected subscribe left no route behind: the channel later existing must not resurrect it.
      fake.createChannel(missing);
      await plugin.subscribe(real, () => undefined);
      await plugin.post(missing, asHandle('writer'), 'to the abandoned route');
      await new Promise((r) => setTimeout(r, 300));
      expect(live).toEqual([]);
    });
  });

  it('an EXISTING but empty channel still returns an empty page, not an absent topic', async () => {
    const topic = asTopic('C0EMPTY');
    await withSlack({ appToken: null, channels: [topic] }, async (_fake, plugin) => {
      const first = await plugin.fetchRecent({ topic });
      expect(first.messages).toEqual([]);
      const again = await plugin.fetchRecent({ topic, since: first.nextCursor });
      expect(again.messages).toEqual([]);
      expect(again.nextCursor).toBe(first.nextCursor);
    });
  });
});
