import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { TelegramPlugin } from '../src/index.js';
import { KNOWN_CHANNEL } from './fake-telegram.js';
import { captureStderr, coldRestart, contentsOf, SENDER, startRig } from './rig.js';

/** A chat no key-agreement cell addresses — its traffic marks the ingestion loop's progress. */
const SENTINEL_CHAT = '-1009409999';

/**
 * Every way a topic can NAME a chat, crossed with which seam call ran first and whether the
 * foreign message arrived before any of them. Inbound updates carry only a numeric `chat.id`,
 * so a bridge that learns the mapping on a write path files everything else under a phantom
 * topic — invisible forever, and persisted that way.
 */
const SPELLINGS = [
  { name: 'numeric literal', topic: '-1009000001', chat: '-1009000001', config: {} },
  {
    name: '@name literal',
    topic: KNOWN_CHANNEL.username,
    chat: String(KNOWN_CHANNEL.id),
    config: {},
  },
  {
    name: 'chat_map to numeric',
    topic: 'ops',
    chat: '-1009000002',
    config: { chat_map: { ops: '-1009000002' } },
  },
  {
    name: 'chat_map to @name',
    topic: 'news',
    chat: String(KNOWN_CHANNEL.id),
    config: { chat_map: { news: KNOWN_CHANNEL.username } },
  },
] as const;

const FIRST_CALLS = ['fetchRecent', 'subscribe', 'post'] as const;

const CELLS = SPELLINGS.flatMap((spelling) =>
  FIRST_CALLS.flatMap((firstCall) =>
    [true, false].map((arriveFirst) => ({ spelling, firstCall, arriveFirst })),
  ),
);

describe('telegram inbound routing', () => {
  it.each(CELLS)(
    'topic as $spelling.name, first seam call $firstCall, message first: $arriveFirst',
    async ({ spelling, firstCall, arriveFirst }) => {
      const rig = await startRig(spelling.config);
      const topic = asTopic(spelling.topic);
      const live: Message[] = [];
      const runFirstCall = async (plugin: TelegramPlugin): Promise<void> => {
        if (firstCall === 'fetchRecent') await plugin.fetchRecent({ topic });
        if (firstCall === 'subscribe') await plugin.subscribe(topic, (m) => live.push(m));
        if (firstCall === 'post') await plugin.post(topic, SENDER, 'own');
      };

      if (arriveFirst) {
        rig.fake.injectUserMessage(spelling.chat, 'alice', 'foreign');
        await vi.waitFor(() => expect(rig.fake.callCount('getUpdates')).toBeGreaterThan(1), {
          timeout: 3000,
          interval: 10,
        });
        await runFirstCall(rig.plugin);
      } else {
        await runFirstCall(rig.plugin);
        rig.fake.injectUserMessage(spelling.chat, 'alice', 'foreign');
      }

      await vi.waitFor(async () => expect(await contentsOf(rig.plugin, topic)).toContain('foreign'), {
        timeout: 3000,
        interval: 10,
      });
      // A live subscriber established before the message must also receive it, stamped with the
      // topic IT named the chat by.
      if (firstCall === 'subscribe' && !arriveFirst) {
        await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('foreign'), {
          timeout: 3000,
          interval: 10,
        });
        expect(live.at(-1)?.topic).toBe(topic);
        expect(live.at(-1)?.backendMsgId).toMatch(new RegExp(`^${spelling.chat}:\\d+$`));
      }

      // Cold restart: the record must be filed under the chat, not a phantom topic — a misfiled
      // record is deduped on the getUpdates backlog replay and can never be recovered.
      expect(await contentsOf(await coldRestart(rig), topic)).toContain('foreign');
    },
  );
});

/**
 * Telegram resolves a `chat_id` NUMERICALLY, and stamps the normalized id on every inbound update
 * and on its own `sendMessage` response. So a topic whose chat reference is numerically — but not
 * textually — canonical must still collapse to that one key. A plugin that keys the store, the
 * subscription and the fetch under the literal spelling makes the topic a permanent black hole:
 * its posts are filed under a key nothing inbound will ever carry, and the Bot API has no history
 * endpoint that could hand them back.
 *
 * One row per spelling, so a ref format nobody has tried yet (a wider supergroup id, a new
 * prefix) fails on its own rather than hiding behind a neighbour.
 */
const NON_CANONICAL_SPELLINGS = [
  { name: 'a leading zero', ref: '-01009300001', canonical: '-1009300001', config: {} },
  { name: 'many leading zeros', ref: '-000001009300002', canonical: '-1009300002', config: {} },
  { name: 'a positive id with leading zeros', ref: '004242', canonical: '4242', config: {} },
  {
    name: 'a chat_map value with a leading zero',
    ref: 'ops',
    canonical: '-1009300003',
    config: { chat_map: { ops: '-01009300003' } },
  },
] as const;

describe('telegram chat-id canonicalization', () => {
  it.each(NON_CANONICAL_SPELLINGS)(
    'a topic naming a chat by $name is one key with the id Telegram stamps',
    async ({ ref, canonical, config }) => {
      const rig = await startRig(config);
      const topic = asTopic(ref);
      const live: Message[] = [];
      await rig.plugin.subscribe(topic, (m) => live.push(m));

      const ownId = await rig.plugin.post(topic, SENDER, 'own');
      expect(ownId as string).toMatch(new RegExp(`^${canonical}:\\d+$`));
      // Our own post is retrievable under the spelling the caller used...
      expect(await contentsOf(rig.plugin, topic)).toEqual(['own']);

      // ...and an inbound update, which carries only the canonical id, routes to the same topic.
      rig.fake.injectUserMessage(canonical, 'alice', 'foreign');
      await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('foreign'), {
        timeout: 3000,
        interval: 10,
      });
      expect(live.at(-1)?.topic).toBe(topic);
      expect(await contentsOf(rig.plugin, topic)).toEqual(['own', 'foreign']);

      // The store filed both under the canonical id, so a cold restart still finds them.
      expect(await contentsOf(await coldRestart(rig), topic)).toEqual(['own', 'foreign']);
    },
  );

  /**
   * The other half of the same key, and the half the client does not choose: how the UPSTREAM
   * spells `chat.id`. `post` resolves its topic through one normalization and then indexed, woke
   * and fanned out under `String(sent.chat.id)` from the response, which is a different one — so a
   * spelling the two disagree on filed the record in a bucket the topic never queries while every
   * seam call reported success, and `store.has(...)`, the guard whose whole job is to catch exactly
   * that, passed vacuously because it asked under the same wrong key.
   *
   * The invariant per cell is one line: the message is reachable through the topic that addressed
   * it, or the call REJECTS naming both ids. Never a topic that swallows posts and stays empty.
   */
  const ECHOED_CHAT_IDS = [
    { name: 'the canonical number', chat: '-1009400001', spell: (id: number) => id, reaches: true },
    {
      name: 'a numeric string with leading zeros',
      chat: '-1009400002',
      spell: (id: number) => `-00${String(-id)}`,
      reaches: true,
    },
    {
      name: 'a different chat than the one addressed',
      chat: '-1009400003',
      spell: (id: number) => id - 1,
      reaches: false,
    },
    {
      // No spelling of its own: JSON's double rounds this id on the way back, which is what
      // `canonicalChatId` normalizes through BigInt to avoid and what the response echo undid.
      name: 'an id rounded past MAX_SAFE_INTEGER',
      chat: '9007199254740993',
      spell: (id: number) => id,
      reaches: false,
    },
  ] as const;

  const INGEST_PATHS = ['a sendMessage response', 'a getUpdates update'] as const;

  const KEY_CELLS = ECHOED_CHAT_IDS.flatMap((echo) =>
    INGEST_PATHS.map((path) => ({ ...echo, path })),
  );

  it.each(KEY_CELLS)(
    'chat.id echoed as $name on $path reaches the addressed topic: $reaches',
    async ({ chat, spell, reaches, path }) => {
      captureStderr();
      const rig = await startRig();
      const topic = asTopic(chat);
      const addressed = BigInt(chat).toString();
      const stamped = BigInt(String(spell(Number(chat)))).toString();
      // Guard the row: a cell whose spelling collapses to the addressed id cannot grade a mismatch.
      expect(stamped === addressed).toBe(reaches);
      rig.fake.spellChatId(spell);

      const live: Message[] = [];
      await rig.plugin.subscribe(topic, (m) => live.push(m));

      if (path === 'a sendMessage response') {
        const posted = await rig.plugin.post(topic, SENDER, 'hello').then(
          (id) => id as string,
          (err: unknown) => err as Error,
        );
        if (reaches) expect(posted).toBe(`${addressed}:1`);
        else {
          expect((posted as Error).message).toContain(addressed);
          expect((posted as Error).message).toContain(stamped);
        }
      } else {
        rig.fake.injectUserMessage(chat, 'alice', 'hello');
        // A sentinel in a chat this cell never touches pins the point the update was consumed, so
        // an unreachable cell is graded on ingestion having happened, not on losing a race.
        rig.fake.spellChatId(undefined);
        rig.fake.injectUserMessage(SENTINEL_CHAT, 'alice', 'sentinel');
        await vi.waitFor(
          async () => expect(await contentsOf(rig.plugin, asTopic(SENTINEL_CHAT))).toContain('sentinel'),
          { timeout: 5000, interval: 20 },
        );
      }

      const expected = reaches ? ['hello'] : [];
      expect(await contentsOf(rig.plugin, topic)).toEqual(expected);
      expect(live.map((m) => m.content)).toEqual(expected);
      // And the verdict survives a restart, which is where a misfiled record becomes permanent.
      expect(await contentsOf(await coldRestart(rig), topic)).toEqual(expected);
    },
    20_000,
  );
});
