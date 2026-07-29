import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A crash, an ENOSPC or a SIGKILL can land anywhere inside a compaction, and a compaction runs on
 * BOTH the load path and the live append path. `store_path` is the ONLY copy of this backend's
 * history — the Bot API has no endpoint that could rebuild it — so an interrupted compaction must
 * leave the pre-compaction file whole, must let the store resume once the obstruction clears, and
 * must never leave a descriptor number behind that a later append can write into. A closed fd
 * number is reused by the next open in the process (an HTTPS socket to the Bot API, the core
 * read-state file), so the third invariant is the difference between losing one compaction and
 * writing JSONL records into an unrelated file.
 *
 * The interruption is modelled at the fs primitives rather than with a real signal: the target the
 * implementation opened is truncated and the write then fails (exactly what a crash after `O_TRUNC`
 * looks like), or the temp file cannot be opened at all (EACCES/EISDIR on `<path>.tmp`).
 */
type Interruption = 'before any bytes' | 'mid content' | 'tmp open fails';
const interruption: { at?: Interruption } = {};

/**
 * Descriptors the store has closed and not reopened, and every operation aimed at one of them.
 * A closed fd NUMBER is handed straight back out by the next open in the process, so the mock
 * answers one the way the operating system would — it succeeds, against someone else's file —
 * rather than with the EBADF only an unreused number would give.
 */
const closedFds = new Set<number>();
const writesToClosedFds: number[] = [];
const closesOfClosedFds: number[] = [];

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const crash = (): never => {
    throw new Error('ENOSPC: no space left on device, write');
  };
  const stale = (target: unknown): boolean => {
    if (typeof target !== 'number' || !closedFds.has(target)) return false;
    writesToClosedFds.push(target);
    return true;
  };
  return {
    ...actual,
    openSync: ((path: string, flags: string, mode?: number): number => {
      if (interruption.at === 'tmp open fails' && String(path).endsWith('.tmp')) {
        throw new Error(`EACCES: permission denied, open '${String(path)}'`);
      }
      const fd = actual.openSync(path, flags, mode);
      closedFds.delete(fd);
      return fd;
    }) as typeof actual.openSync,
    closeSync: ((fd: number): void => {
      if (closedFds.has(fd)) {
        closesOfClosedFds.push(fd);
        return;
      }
      closedFds.add(fd);
      actual.closeSync(fd);
    }) as typeof actual.closeSync,
    appendFileSync: ((target: unknown, data: string): void => {
      if (stale(target)) return;
      actual.appendFileSync(target as number, data);
    }) as typeof actual.appendFileSync,
    writeSync: ((fd: number, data: string): number => {
      if (stale(fd)) return data.length;
      if (interruption.at !== 'before any bytes' && interruption.at !== 'mid content') {
        return actual.writeSync(fd, data);
      }
      if (interruption.at === 'mid content') actual.writeSync(fd, data.slice(0, data.length >> 1));
      actual.ftruncateSync(fd, interruption.at === 'mid content' ? data.length >> 1 : 0);
      return crash();
    }) as typeof actual.writeSync,
  };
});

const { ObservedStore } = await import('../src/store.js');
const { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } = await vi.importActual<
  typeof import('node:fs')
>('node:fs');
const { tmpdir } = await import('node:os');
const { join } = await import('node:path');

const RECORDS = 20;
const INTERRUPTIONS: Interruption[] = ['before any bytes', 'mid content', 'tmp open fails'];
const FAILURE = { 'before any bytes': /ENOSPC/, 'mid content': /ENOSPC/, 'tmp open fails': /EACCES/ };

const record = (messageId: number, seq: number) => ({
  chat_id: '-1',
  message_id: messageId,
  seq,
  sender: 's',
  content: `m${messageId}`,
  ts: '2024-01-01T00:00:00.000Z',
});

let dir: string;
let path: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'parley-tg-compact-'));
  path = join(dir, 'store.jsonl');
  closedFds.clear();
  writesToClosedFds.length = 0;
  closesOfClosedFds.length = 0;
  const lines = Array.from({ length: RECORDS }, (_, i) => JSON.stringify(record(i + 1, i + 1)));
  writeFileSync(path, `${lines.join('\n')}\n`);
});
afterEach(() => {
  interruption.at = undefined;
  rmSync(dir, { recursive: true, force: true });
});

const contentsOnDisk = (): string[] =>
  readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .filter((l) => l !== '')
    .map((l) => (JSON.parse(l) as { content: string }).content);

describe('telegram ObservedStore compaction survives an interruption', () => {
  it.each(INTERRUPTIONS)('on the LOAD path, %s leaves every pre-compaction record readable', (at) => {
    interruption.at = at;
    // A tighter cap forces a compaction on load; it is interrupted before it can replace the file.
    expect(() => new ObservedStore(path, 5)).toThrow(FAILURE[at]);
    interruption.at = undefined;

    expect(contentsOnDisk()).toEqual(Array.from({ length: RECORDS }, (_, i) => `m${i + 1}`));
    const reopened = new ObservedStore(path, RECORDS * 2);
    expect(reopened.entries('-1').map((r) => r.content)).toEqual(
      Array.from({ length: RECORDS }, (_, i) => `m${i + 1}`),
    );
    // The store resumes: a record appended after the obstruction cleared is retrievable.
    expect(reopened.append(record(99, 99))).toBeDefined();
    reopened.close();
    expect(new ObservedStore(path, RECORDS * 2).entries('-1').at(-1)?.content).toBe('m99');
    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect({ writesToClosedFds, closesOfClosedFds }).toEqual({
      writesToClosedFds: [],
      closesOfClosedFds: [],
    });
  });

  it.each(INTERRUPTIONS)('at RUNTIME, %s leaves the store appendable and its fd valid', (at) => {
    const store = new ObservedStore(path, 2);
    expect(store.isOpen()).toBe(true);
    // Each append past the cap evicts one record; the second arms the amortized rewrite.
    expect(store.append(record(50, 50))).toBeDefined();
    const beforeCompaction = contentsOnDisk();
    interruption.at = at;
    expect(() => store.append(record(51, 51))).toThrow(FAILURE[at]);
    interruption.at = undefined;

    expect(store.isOpen()).toBe(true);
    // The pre-compaction file is intact: the rename never ran, so nothing was truncated away.
    expect(contentsOnDisk()).toEqual([...beforeCompaction, 'm51']);
    expect(store.entries('-1').map((r) => r.content)).toEqual(['m50', 'm51']);

    // Once the obstruction clears the store resumes, compacts, and the record is retrievable.
    expect(store.append(record(52, 52))).toBeDefined();
    expect(store.entries('-1').map((r) => r.content)).toEqual(['m51', 'm52']);
    store.close();
    // Every operation since the failed compaction named a descriptor the store still held.
    expect({ writesToClosedFds, closesOfClosedFds }).toEqual({
      writesToClosedFds: [],
      closesOfClosedFds: [],
    });

    const reopened = new ObservedStore(path, 2);
    expect(reopened.entries('-1').map((r) => r.content)).toEqual(['m51', 'm52']);
    reopened.close();
    expect(existsSync(`${path}.tmp`)).toBe(false);
  });

  it('completes normally when nothing interrupts it', () => {
    const store = new ObservedStore(path, 5);
    expect(store.entries('-1').map((r) => r.content)).toEqual(['m16', 'm17', 'm18', 'm19', 'm20']);
    store.close();

    const reopened = new ObservedStore(path, RECORDS * 2);
    expect(reopened.entries('-1')).toHaveLength(5);
    reopened.close();
    expect({ writesToClosedFds, closesOfClosedFds }).toEqual({
      writesToClosedFds: [],
      closesOfClosedFds: [],
    });
  });
});
