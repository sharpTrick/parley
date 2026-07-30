import { asHandle, asTopic, type Topic } from '@sharptrick/parley-core';
import { describe, expect, it, vi } from 'vitest';
import type { TelegramPlugin } from '../src/index.js';
import { captureStderr, type Rig, startRig } from './rig.js';

/**
 * The failure the next `appendFileSync` in this process will suffer. `undefined` = write normally.
 * Hoisted, because `vi.mock`'s factory is evaluated before the module body.
 */
const nextWrite = vi.hoisted(() => ({
  fails: undefined as 'before any bytes' | 'after a partial line' | 'after a complete line' | undefined,
}));

/**
 * A write to a file can fail HAVING ALREADY WRITTEN — `appendFileSync` loops over `writeSync`, so a
 * disk that fills mid-call leaves bytes with no terminating newline. Nothing else in this package
 * can produce that: the existing store-visibility cells stub `append` itself, which throws before
 * any byte reaches the file, and the store's torn-tail repair only runs in the CONSTRUCTOR — so a
 * fragment created mid-run was never repaired by the process that made it, and the next record was
 * glued onto it and lost, after `append` had returned it and `post` had resolved with its id.
 */
vi.mock('node:fs', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:fs')>();
  return {
    ...real,
    default: real,
    appendFileSync: (target: number, data: string, options?: unknown): void => {
      const mode = nextWrite.fails;
      if (mode === undefined) {
        real.appendFileSync(target, data, options as undefined);
        return;
      }
      nextWrite.fails = undefined;
      if (mode === 'after a partial line') real.writeSync(target, data.slice(0, data.length >> 1));
      if (mode === 'after a complete line') real.writeSync(target, data);
      throw Object.assign(new Error('ENOSPC: no space left on device, write'), { code: 'ENOSPC' });
    },
  };
});

const SENDER = asHandle('me');
const CHAT = '-1006200001';

const contentsOf = async (plugin: TelegramPlugin, topic: Topic): Promise<string[]> =>
  (await plugin.fetchRecent({ topic, limit: 100 })).messages.map((m) => m.content);

const WRITE_FAILURES = ['before any bytes', 'after a partial line', 'after a complete line'] as const;
const INGEST_PATHS = ['an inbound update', 'an own post'] as const;

const CELLS = WRITE_FAILURES.flatMap((fails) => INGEST_PATHS.map((path) => ({ fails, path })));

describe('telegram store survives a write that failed part-way', () => {
  it.each(CELLS)(
    'a record write failing $fails on $path costs only that record',
    async ({ fails, path }) => {
      const stderr = captureStderr();
      const rig: Rig = await startRig();
      const topic = asTopic(CHAT);
      await rig.plugin.post(topic, SENDER, 'seed');
      await vi.waitFor(async () => expect(await contentsOf(rig.plugin, topic)).toEqual(['seed']), {
        timeout: 5000,
        interval: 10,
      });

      nextWrite.fails = fails;
      let postError: Error | undefined;
      if (path === 'an own post') {
        postError = await rig.plugin.post(topic, SENDER, 'subject').then(
          () => undefined,
          (e: unknown) => e as Error,
        );
      } else {
        rig.fake.injectUserMessage(CHAT, 'alice', 'subject');
        await vi.waitFor(() => expect(stderr.join('')).toMatch(/dropped update/), {
          timeout: 5000,
          interval: 20,
        });
      }
      // The obstruction really bit — a cell whose write never failed would grade nothing.
      expect(`${stderr.join('')}${postError?.message ?? ''}`).toMatch(/ENOSPC/);

      // The very next message is written, served, and must survive the reload: `append` returning a
      // record is a durability claim, and gluing it onto an unterminated fragment retracts that
      // claim at the next load, where nothing can notice.
      const after = path === 'an own post' ? await rig.plugin.post(topic, SENDER, 'after') : undefined;
      if (after === undefined) rig.fake.injectUserMessage(CHAT, 'alice', 'after');
      await vi.waitFor(async () => expect(await contentsOf(rig.plugin, topic)).toContain('after'), {
        timeout: 5000,
        interval: 20,
      });

      const live = await contentsOf(rig.plugin, topic);
      await rig.plugin.disconnect();
      const cold = await contentsOf(await rig.restart(), topic);
      for (const content of live) expect(cold).toContain(content);
      expect(cold).toContain('after');
      expect(cold).toContain('seed');
    },
    20_000,
  );
});
