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
 * The most bytes one `writeSync` call may take, or `undefined` for every byte it is offered. This
 * is the interruption that does NOT announce itself: `writeSync` performs ONE `write(2)` and
 * returns the count the kernel took, so a filesystem that accepts part of a rewrite reports
 * SUCCESS for that part, and a caller watching only the exception channel hears nothing at all.
 */
const writeCeiling: { bytes?: number } = {};

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
    // Honour the (offset, length) region the caller named rather than the whole buffer, so that a
    // writer looping over its remainder is graded on what it actually asked for — a mock that
    // ignored them would write the whole file on every iteration and call any loop correct.
    writeSync: ((fd: number, data: unknown, offset?: number, length?: number): number => {
      const whole = typeof data === 'string' ? Buffer.from(data, 'utf8') : (data as Buffer);
      const from = offset ?? 0;
      const asked = whole.subarray(from, from + (length ?? whole.byteLength - from));
      if (stale(fd)) return asked.byteLength;
      if (writeCeiling.bytes !== undefined) {
        return actual.writeSync(fd, asked.subarray(0, Math.min(writeCeiling.bytes, asked.byteLength)));
      }
      if (interruption.at !== 'before any bytes' && interruption.at !== 'mid content') {
        return actual.writeSync(fd, asked);
      }
      const half = asked.byteLength >> 1;
      if (interruption.at === 'mid content') actual.writeSync(fd, asked.subarray(0, half));
      actual.ftruncateSync(fd, interruption.at === 'mid content' ? half : 0);
      return crash();
    }) as typeof actual.writeSync,
  };
});

const { ObservedStore } = await import('../src/store.js');
const { captureStderr } = await import('./rig.js');
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
  writeCeiling.bytes = undefined;
  rmSync(dir, { recursive: true, force: true });
});

/** Record contents on disk — the dedup memory a compaction persists is not a record. */
const contentsOnDisk = (): string[] =>
  readFileSync(path, 'utf8')
    .trimEnd()
    .split('\n')
    .filter((l) => l !== '' && !l.startsWith('#'))
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
    const stderr = captureStderr();
    const store = new ObservedStore(path, 2);
    expect(store.isOpen()).toBe(true);
    // Each append past the cap evicts one record; the second arms the amortized rewrite.
    expect(store.append(record(50, 50))).toBeDefined();
    const beforeCompaction = contentsOnDisk();
    interruption.at = at;
    // The record is durable BEFORE the compaction runs, so the amortized rewrite failing is
    // reported — never turned into a failed append the caller would report as a lost message.
    expect(store.append(record(51, 51))).toBeDefined();
    expect(stderr.join('')).toMatch(FAILURE[at]);
    expect(stderr.join('')).toContain(`could not compact ${path}`);
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

  /**
   * The write primitive that can return SHORT. Every other row here fails loudly; this one is the
   * shape where the filesystem says yes to a prefix, so a writer that reads only the exception
   * channel renames that prefix over the only copy of this backend's history and tells every caller
   * it worked. Swept over per-call ceilings rather than asserted at one size, so a writer that
   * loops but drops its final partial chunk, or one that restarts from byte 0 each time, fails a
   * row too; the ceiling above the whole file is the row that must stay green whatever the writer
   * does, so a table gone uniformly red is visible as such.
   */
  const CEILINGS = [1, 13, 512, 1_000_000];

  it.each(CEILINGS)(
    'publishes every byte of a compaction when the filesystem takes %i per write',
    (bytes) => {
      const keep = 5;
      const kept = Array.from({ length: keep }, (_, i) => `m${RECORDS - keep + i + 1}`);
      writeCeiling.bytes = bytes;
      // A tighter cap forces the compaction onto the load path, where nothing catches a throw.
      const store = new ObservedStore(path, keep);
      writeCeiling.bytes = undefined;

      expect(store.entries('-1').map((r) => r.content)).toEqual(kept);
      expect(contentsOnDisk()).toEqual(kept);
      // A file cut mid-line is what the next append glues onto, so the rewrite must end a line.
      expect(readFileSync(path, 'utf8').endsWith('\n')).toBe(true);
      expect(store.append(record(99, 99))).toBeDefined();
      store.close();

      const reopened = new ObservedStore(path, keep);
      expect(reopened.entries('-1').map((r) => r.content)).toEqual([...kept.slice(1), 'm99']);
      reopened.close();
      expect(existsSync(`${path}.tmp`)).toBe(false);
    },
  );

  /**
   * A ceiling of nothing. A filesystem that takes zero bytes and reports no error makes no
   * progress, so the rewrite must REFUSE rather than spin on it or publish what it managed —
   * the one shape where "loop until the buffer is gone" would never return.
   */
  it('refuses a rewrite the filesystem takes no bytes of, keeping the file it would replace', () => {
    writeCeiling.bytes = 0;
    expect(() => new ObservedStore(path, 5)).toThrow(/took 0 of \d+ bytes/);
    writeCeiling.bytes = undefined;

    expect(contentsOnDisk()).toEqual(Array.from({ length: RECORDS }, (_, i) => `m${i + 1}`));
    expect(existsSync(`${path}.tmp`)).toBe(false);
    const reopened = new ObservedStore(path, RECORDS * 2);
    expect(reopened.entries('-1')).toHaveLength(RECORDS);
    reopened.close();
  });

  /**
   * The same primitive writes the sequence high-water BESIDE the file, and there a short write is
   * silent by construction: a decimal prefix of a number is a smaller number, so the truncated mark
   * agrees with every file it could be read against and the rolled-back tail it exists to catch
   * loads as whole. Graded through what the mark BUYS — a refused identity — rather than by reading
   * the sibling, so the check survives any change to how the mark is spelled.
   */
  it('records a high-water a rolled-back tail cannot satisfy, one byte per write', () => {
    const stderr = captureStderr();
    const own = join(dir, 'hw.jsonl');
    writeCeiling.bytes = 1;
    const store = new ObservedStore(own);
    for (let i = 1; i <= 12; i++) expect(store.append(record(i, i))).toBeDefined();
    const issued = store.epoch();
    store.close();
    writeCeiling.bytes = undefined;

    // Restore an earlier copy of the file: every line it keeps agrees with every other, so the
    // mark beside it is the only thing left that knows records once reached 12.
    const lines = readFileSync(own, 'utf8').trimEnd().split('\n');
    writeFileSync(own, `${lines.slice(0, 1 + 2 * 5).join('\n')}\n`);

    const reopened = new ObservedStore(own);
    expect(reopened.epoch()).not.toBe(issued);
    expect(stderr.join('')).toMatch(/the high-water recorded beside it is 12/);
    reopened.close();
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
