import { readFileSync } from 'node:fs';
import { asTopic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import {
  captureStderr,
  coldRestart as restart,
  contentsOf,
  type Rig,
  SENDER,
  startRig,
} from './rig.js';

/**
 * Anyone who can add the bot to a group drives writes into the operator's store file. Ingest
 * of chats no configured topic names must not grow the file without limit.
 */
describe('telegram unconfigured-chat ingest', () => {
  it('stays bounded under a flood of unknown chats while the served topic keeps working', async () => {
    const rig = await startRig({ observed_retention_per_topic: 2, observed_max_chats: 3 });
    const chat = '-1007000001';
    const topic = asTopic(chat);
    await rig.plugin.subscribe(topic, () => undefined);

    for (let c = 0; c < 40; c++) {
      for (let i = 0; i < 4; i++) rig.fake.injectUserMessage(`-200${c}`, 'mallory', `flood-${c}-${i}`);
    }
    rig.fake.injectUserMessage(chat, 'alice', 'mine');

    await vi.waitFor(async () => expect(await contentsOf(rig.plugin, topic)).toContain('mine'), {
      timeout: 5000,
      interval: 10,
    });
    // 3 unconfigured chats + the served one, 2 records each, plus at most one compaction lag.
    const lines = readFileSync(rig.storePath, 'utf8').trimEnd().split('\n');
    expect(lines.length).toBeLessThanOrEqual(2 * (2 * 4 + 2));
  });

  const OPS_CHAT = '-1007007777';
  const SENTINEL_CHAT = '-1007005555';
  const FLOOD_CHATS = Array.from({ length: 10 }, (_, i) => `-90000${i}`);
  /** A served chat outside the contest, so waiting for ingestion never itself serves a chat. */
  const STARVATION_CONFIG = { observed_max_chats: 3, chat_map: { sentinel: SENTINEL_CHAT } };
  let marker = 0;

  /**
   * Park until the poll loop has consumed everything injected so far. Updates are delivered in
   * order, so a marker in an ALREADY-served chat pins the point — polling the topic under test
   * would register it as served and make the starvation being tested unreproducible.
   */
  const drainUpdates = async (rig: Rig): Promise<void> => {
    const content = `sentinel-${++marker}`;
    rig.fake.injectUserMessage(SENTINEL_CHAT, 'ops', content);
    await vi.waitFor(
      async () => expect(await contentsOf(rig.plugin, asTopic('sentinel'))).toContain(content),
      { timeout: 8000, interval: 20 },
    );
  };

  const floodAndWait = async (rig: Rig): Promise<void> => {
    for (const c of FLOOD_CHATS) rig.fake.injectUserMessage(c, 'mallory', `flood-${c}`);
    await drainUpdates(rig);
  };

  /**
   * The ingestion loop starts before any seam call could have named a topic, so a chat the
   * operator configured is UNSERVED for that window. A flood arriving in it must not be able to
   * make the operator's own messages undeliverable — the update is acknowledged to Telegram the
   * moment it is read, so a refused record is gone for good.
   *
   * The third axis is the RESTART, because the protection has to be durable to be worth anything:
   * `chat_map` is re-declared on every connect, a topic named only by a seam call is not, and the
   * load-time chat cap runs before any seam call could name one. A protection that lived only in
   * this process's memory would hand the operator's own history to the flood at the next restart —
   * and the Bot API has no endpoint that could ever put it back.
   */
  const STARVATION_CELLS = (['never', 'fetchRecent', 'subscribe', 'post'] as const).flatMap(
    (firstCall) =>
      (['before', 'after'] as const)
        .filter((flood) => !(firstCall === 'never' && flood === 'after'))
        .flatMap((flood) => [false, true].map((coldRestart) => ({ firstCall, flood, coldRestart }))),
  );

  it.each(STARVATION_CELLS)(
    'keeps the operator message when the topic is first named by $firstCall, the flood lands $flood it, cold restart: $coldRestart',
    async ({ firstCall, flood, coldRestart }) => {
      const rig = await startRig(STARVATION_CONFIG);
      const topic = asTopic(OPS_CHAT);
      const runFirstCall = async (): Promise<void> => {
        if (firstCall === 'fetchRecent') await rig.plugin.fetchRecent({ topic });
        if (firstCall === 'subscribe') await rig.plugin.subscribe(topic, () => undefined);
        if (firstCall === 'post') await rig.plugin.post(topic, SENDER, 'own');
      };

      if (flood === 'before') {
        await floodAndWait(rig);
        await runFirstCall();
        rig.fake.injectUserMessage(OPS_CHAT, 'alice', 'mine');
        await drainUpdates(rig);
      } else {
        await runFirstCall();
        rig.fake.injectUserMessage(OPS_CHAT, 'alice', 'mine');
        await drainUpdates(rig);
        await floodAndWait(rig);
      }

      expect(await contentsOf(rig.plugin, topic)).toContain('mine');
      if (!coldRestart) return;
      // Nothing may re-declare the topic in the new process before the flood arrives in it: the
      // mark the previous run left on the file is the only thing that can be protecting it here.
      const cold = { ...rig, plugin: await restart(rig) };
      await floodAndWait(cold);
      expect(await contentsOf(cold.plugin, topic)).toContain('mine');
    },
    30_000,
  );

  /**
   * The residual limit of that protection, pinned so the README cannot drift from it: a topic no
   * seam call has ever named is not protected from a LATER flood — `chat_map` is what protects
   * it, because `connect` resolves those chats before the store is even opened.
   */
  it('protects a topic from a later flood once chat_map names it, not before', async () => {
    // Nothing may name the topic before the flood — a fetchRecent to check on it would itself
    // register the chat as served, which is exactly the protection under test.
    const unnamed = await startRig(STARVATION_CONFIG);
    unnamed.fake.injectUserMessage(OPS_CHAT, 'alice', 'mine');
    await drainUpdates(unnamed);
    await floodAndWait(unnamed);
    expect(await contentsOf(unnamed.plugin, asTopic(OPS_CHAT))).not.toContain('mine');

    const mapped = await startRig({
      ...STARVATION_CONFIG,
      chat_map: { ...STARVATION_CONFIG.chat_map, ops: OPS_CHAT },
    });
    mapped.fake.injectUserMessage(OPS_CHAT, 'alice', 'mine');
    await drainUpdates(mapped);
    await floodAndWait(mapped);
    expect(await contentsOf(mapped.plugin, asTopic('ops'))).toContain('mine');
  }, 30_000);

  /**
   * A refused record is permanent message loss — the update was acknowledged to Telegram before the
   * store saw it — so it must never be silent. A DUPLICATE is the opposite: expected on every
   * backlog replay, and reporting it would tell the operator to raise a bound that is not the
   * problem. Both halves of the title are graded, and both kinds of duplicate are: one whose record
   * is still retained, and one retention has already evicted.
   */
  const DUP_CHAT = '-1007001001';

  it('reports a record the store refuses, and stays silent on a duplicate', async () => {
    const stderr = captureStderr();
    // Both configured chats are served from connect, so the cap has no unserved chat to displace.
    const rig = await startRig({
      observed_max_chats: 2,
      observed_retention_per_chat: 2,
      chat_map: { a: DUP_CHAT, b: '-1007001002' },
    });
    // The second served chat has to be present for the cap to have nothing unserved to displace.
    await rig.plugin.post(asTopic('b'), SENDER, 'b');
    const evicted = rig.fake.injectUserMessage(DUP_CHAT, 'alice', 'oldest');
    const retained = rig.fake.injectUserMessage(DUP_CHAT, 'alice', 'newer');
    rig.fake.injectUserMessage(DUP_CHAT, 'alice', 'newest');
    await vi.waitFor(
      async () => expect(await contentsOf(rig.plugin, asTopic('a'))).toEqual(['newer', 'newest']),
      { timeout: 8000, interval: 20 },
    );

    // Both copies are duplicates: one of a retained record, one of a record retention has dropped.
    for (const [messageId, text] of [
      [evicted, 'oldest'],
      [retained, 'newer'],
    ] as const) {
      rig.fake.injectRaw(DUP_CHAT, {
        message_id: messageId,
        from: { id: 5, is_bot: false, username: 'alice' },
        text,
      });
    }
    rig.fake.injectUserMessage(DUP_CHAT, 'alice', 'sentinel');
    await vi.waitFor(
      async () => expect(await contentsOf(rig.plugin, asTopic('a'))).toContain('sentinel'),
      { timeout: 8000, interval: 20 },
    );
    expect(stderr.join('')).not.toMatch(/dropped/);

    rig.fake.injectUserMessage('-1007009999', 'mallory', 'refused');
    await vi.waitFor(() => expect(stderr.join('')).toMatch(/dropped a message for chat/), {
      timeout: 8000,
      interval: 20,
    });
    expect(stderr.join('')).toContain('-1007009999');
    expect(stderr.join('')).not.toContain(DUP_CHAT);
  }, 20_000);
});
