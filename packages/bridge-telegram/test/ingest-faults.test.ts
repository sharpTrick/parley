import { mkdirSync } from 'node:fs';
import { asTopic, type Message } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import { type ObservedRecord, ObservedStore, type StoredRecord } from '../src/store.js';
import { captureStderr, contentsOf, registerCleanup, SENDER, startRig } from './rig.js';

/**
 * The getUpdates loop is the only ingestion path and it is detached: anything that throws
 * inside it (a full disk on the store write, a subscriber handler) must not take live push
 * down for the rest of the process, nor surface as an unhandled rejection.
 */
describe('telegram poll-loop fault isolation', () => {
  const THROW_SITES = ['store append', 'subscriber handler'] as const;

  it.each(THROW_SITES)('keeps consuming updates when %s throws', async (site) => {
    const unhandled: unknown[] = [];
    const onUnhandled = (err: unknown): void => void unhandled.push(err);
    process.on('unhandledRejection', onUnhandled);
    registerCleanup(() => void process.off('unhandledRejection', onUnhandled));

    captureStderr();
    const rig = await startRig();
    const chat = '-1006000123';
    const topic = asTopic(chat);
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => {
      if (site === 'subscriber handler' && m.content === 'poison') throw new Error('handler blew up');
      live.push(m);
    });
    if (site === 'store append') {
      vi.spyOn(ObservedStore.prototype, 'append').mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device');
      });
    }

    rig.fake.injectUserMessage(chat, 'alice', 'poison');
    rig.fake.injectUserMessage(chat, 'alice', 'after');

    await vi.waitFor(() => expect(live.map((m) => m.content)).toContain('after'), {
      timeout: 3000,
      interval: 10,
    });
    expect(await contentsOf(rig.plugin, topic)).toContain('after');
    await new Promise((r) => setTimeout(r, 20));
    expect(unhandled).toEqual([]);
  });
});

/**
 * Store-visibility and delivery are ONE decision, and a step that runs after the record is already
 * durable must not be able to split them. The amortized compaction is that step: it runs at the end
 * of `append`, so a full disk or an unusable temp path used to throw out of a write that had already
 * succeeded — the caller was told the message was dropped, no live subscriber was pushed it, and a
 * parked long poll waited out its whole budget for a message the very next `fetchRecent` returned.
 *
 * Each cell fails one step on one ingest path and grades the invariant in BOTH directions: a record
 * `fetchRecent` can see also reached every subscriber and woke every waiter, or it is absent
 * everywhere and the caller was told so.
 *
 * Whether the record ends up present is NOT the same question as whether the failing step ran after
 * it was durable, so the two are separate axes here. An inbound update whose write failed is not
 * acknowledged to Telegram, so the retained backlog serves it again and the record arrives late; an
 * own post has no redelivery at all — `sendMessage` is the only time this bridge ever sees it — so
 * the same failure is permanent and the caller is told. A table that folded the two would grade
 * "absent everywhere" as the right answer for an update that is merely in flight.
 */
describe('telegram store visibility and delivery', () => {
  const FAILING_STEPS = [
    { name: 'the record write', persists: false },
    { name: 'the compaction after the write', persists: true },
  ];
  const INGEST_PATHS = [
    { name: 'an inbound update', redelivers: true },
    { name: 'an own post', redelivers: false },
  ];
  const AGREEMENT_CELLS = FAILING_STEPS.flatMap((step) =>
    INGEST_PATHS.map(({ name, redelivers }) => ({
      step: step.name,
      persists: step.persists,
      path: name,
      durable: step.persists || redelivers,
    })),
  );

  it.each(AGREEMENT_CELLS)('never disagree when $step fails on $path', async ({ durable, persists, path }) => {
    const stderr = captureStderr();
    // Newest-1, so the very next append evicts and arms the amortized rewrite.
    const rig = await startRig({ observed_retention_per_chat: 1 });
    const chat = '-1006100001';
    const topic = asTopic(chat);
    await rig.plugin.post(topic, SENDER, 'seed');
    const tail = (await rig.plugin.fetchRecent({ topic, limit: 100 })).nextCursor;
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => live.push(m));
    const parked = rig.plugin.fetchRecent({ topic, since: tail, blockMs: 1500 });

    if (persists) {
      // A directory at the temp path: every compaction fails, and none of them can touch a record.
      mkdirSync(`${rig.storePath}.tmp`);
    } else {
      vi.spyOn(ObservedStore.prototype, 'append').mockImplementationOnce(() => {
        throw new Error('ENOSPC: no space left on device');
      });
    }

    let postError: Error | undefined;
    if (path === 'an own post') {
      postError = await rig.plugin.post(topic, SENDER, 'subject').then(
        () => undefined,
        (e: unknown) => e as Error,
      );
    } else {
      rig.fake.injectUserMessage(chat, 'alice', 'subject');
    }
    // Settle on the OUTCOME — visible, or the caller told it did not land — never on a diagnostic
    // naming an intermediate decision: an update the loop is holding back for redelivery is still
    // in flight, and a wait that stopped there would grade the in-flight state as the final one.
    await vi.waitFor(
      async () =>
        expect(
          (await contentsOf(rig.plugin, topic)).includes('subject') || postError !== undefined,
        ).toBe(true),
      { timeout: 5000, interval: 20 },
    );

    // The step under test really failed — a cell whose obstruction never bit would grade nothing.
    const reported = `${stderr.join('')}${postError?.message ?? ''}`;
    expect(reported).toMatch(persists ? /could not compact/ : /ENOSPC/);
    const woke = (await parked).messages.map((m) => m.content).includes('subject');
    expect({
      visible: (await contentsOf(rig.plugin, topic)).includes('subject'),
      pushed: live.map((m) => m.content).includes('subject'),
      woke,
    }).toEqual({ visible: durable, pushed: durable, woke: durable });
    // A post whose record never landed is never a resolved post.
    if (path === 'an own post') expect(postError === undefined).toBe(durable);
  }, 20_000);
});

/**
 * `offset` is an ACKNOWLEDGEMENT: Telegram deletes every update below it, and the ~24h retained
 * backlog is the only redelivery this backend has — on the one backend whose observed store is the
 * only history it can ever produce, with no endpoint that could backfill what the offset walked
 * past. So the acknowledgement must not outrun durability: it may never move past an update the
 * store did not take for a reason that can still clear, and it MUST move past one refused for a
 * reason that cannot, or ingestion wedges on a batch nothing downstream can ever be given.
 *
 * The row is the obstruction and how long it lasts, and each is graded on both halves at once —
 * closing either alone produces the other's bug. Grading only that an obstructed message is absent
 * everywhere is exactly what let a lost one look correct.
 */
describe('telegram ingest obstruction and redelivery', () => {
  const OBSTRUCTIONS = [
    {
      name: 'a store write that throws',
      clears: true,
      refuse: (): StoredRecord | undefined => {
        throw new Error('ENOSPC: no space left on device');
      },
    },
    {
      name: 'a store with no append descriptor',
      clears: true,
      open: false,
      refuse: (): StoredRecord | undefined => undefined,
    },
    {
      name: 'a chat cap that refuses the record',
      clears: false,
      open: true,
      refuse: (): StoredRecord | undefined => undefined,
    },
  ];
  const RUNS = [
    { run: 'one attempt', attempts: 1 },
    { run: 'a run of attempts', attempts: 3 },
  ];
  const CELLS = OBSTRUCTIONS.flatMap((o) => RUNS.map((r) => ({ ...o, ...r })));

  it.each(CELLS)('acknowledges nothing past $name lasting $run', async ({ clears, open, refuse, attempts }) => {
    captureStderr();
    const rig = await startRig();
    const chat = '-1006500001';
    const topic = asTopic(chat);
    const live: Message[] = [];
    await rig.plugin.subscribe(topic, (m) => live.push(m));

    const realAppend = ObservedStore.prototype.append;
    let attempted = 0;
    let obstructed = true;
    vi.spyOn(ObservedStore.prototype, 'isOpen').mockImplementation(function (this: ObservedStore) {
      return !obstructed || open !== false;
    });
    vi.spyOn(ObservedStore.prototype, 'append').mockImplementation(function (
      this: ObservedStore,
      observed: ObservedRecord,
    ) {
      if (!obstructed || observed.content !== 'subject') return realAppend.call(this, observed);
      attempted++;
      return refuse();
    });

    rig.fake.injectUserMessage(chat, 'alice', 'subject');
    if (clears) {
      await vi.waitFor(() => expect(attempted).toBeGreaterThanOrEqual(attempts), {
        timeout: 8000,
        interval: 10,
      });
      // Still in Telegram's backlog while the store cannot take it — asked WHILE the obstruction
      // holds, so it cannot pass by sampling after the retry that finally succeeded.
      expect(rig.fake.retainedUpdates()).toBe(1);
    } else {
      await vi.waitFor(() => expect(rig.fake.retainedUpdates()).toBe(0), {
        timeout: 8000,
        interval: 10,
      });
      // A refusal that can never clear is acknowledged once and never re-attempted.
      expect(attempted).toBe(1);
    }

    obstructed = false;
    rig.fake.injectUserMessage(chat, 'alice', 'later');
    // The loop kept consuming either way: an obstruction must never cost the only ingestion path.
    await vi.waitFor(async () => expect(await contentsOf(rig.plugin, topic)).toContain('later'), {
      timeout: 8000,
      interval: 20,
    });
    expect({
      visible: (await contentsOf(rig.plugin, topic)).includes('subject'),
      pushed: live.map((m) => m.content).includes('subject'),
    }).toEqual({ visible: clears, pushed: clears });
  }, 30_000);
});
