import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A crash, an ENOSPC or a SIGKILL can land anywhere inside a compaction. `store_path` is the ONLY
 * copy of this backend's history — the Bot API has no endpoint that could rebuild it — so an
 * interrupted compaction must leave the pre-compaction file whole, never a truncated or
 * half-written one.
 *
 * The interruption is modelled at the write primitive rather than with a real signal: the target
 * the implementation opened is truncated and the write then fails, which is exactly what a crash
 * after `O_TRUNC` looks like. A compaction that writes `store_path` in place loses history here;
 * one that writes a temp file and renames loses nothing.
 */
const interruption: { at?: 'before any bytes' | 'mid content' } = {};

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const crash = (): never => {
    throw new Error('ENOSPC: no space left on device, write');
  };
  return {
    ...actual,
    writeSync: ((fd: number, data: string): number => {
      if (interruption.at === undefined) return actual.writeSync(fd, data);
      if (interruption.at === 'mid content') actual.writeSync(fd, data.slice(0, data.length >> 1));
      actual.ftruncateSync(fd, interruption.at === 'mid content' ? data.length >> 1 : 0);
      return crash();
    }) as typeof actual.writeSync,
    writeFileSync: ((target: string, data: string): void => {
      if (interruption.at === undefined) {
        actual.writeFileSync(target, data);
        return;
      }
      actual.writeFileSync(target, interruption.at === 'mid content' ? data.slice(0, data.length >> 1) : '');
      crash();
    }) as typeof actual.writeFileSync,
  };
});

const { ObservedStore } = await import('../src/store.js');
const { existsSync, mkdtempSync, rmSync, writeFileSync } = await vi.importActual<typeof import('node:fs')>('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const RECORDS = 20;

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parley-tg-compact-'));
  path = join(dir, 'store.jsonl');
  const lines = Array.from({ length: RECORDS }, (_, i) =>
    JSON.stringify({
      chat_id: '-1',
      message_id: i + 1,
      seq: i + 1,
      sender: 's',
      content: `m${i + 1}`,
      ts: '2024-01-01T00:00:00.000Z',
    }),
  );
  writeFileSync(path, `${lines.join('\n')}\n`);
});
afterEach(() => {
  interruption.at = undefined;
  rmSync(dir, { recursive: true, force: true });
});

describe('telegram ObservedStore compaction is crash-atomic', () => {
  it.each(['before any bytes', 'mid content'] as const)(
    'an interruption %s leaves every pre-compaction record readable',
    (at) => {
      interruption.at = at;
      // A tighter cap forces a compaction on load; it is interrupted before it can replace the file.
      expect(() => new ObservedStore(path, 5)).toThrow(/ENOSPC/);
      interruption.at = undefined;

      const reopened = new ObservedStore(path, RECORDS * 2);
      expect(reopened.entries('-1').map((r) => r.content)).toEqual(
        Array.from({ length: RECORDS }, (_, i) => `m${i + 1}`),
      );
      reopened.close();
      expect(existsSync(`${path}.tmp`)).toBe(false);
    },
  );

  it('completes normally when nothing interrupts it', () => {
    const store = new ObservedStore(path, 5);
    expect(store.entries('-1').map((r) => r.content)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20']);
    store.close();

    const reopened = new ObservedStore(path, RECORDS * 2);
    expect(reopened.entries('-1')).toHaveLength(5);
    reopened.close();
  });
});
