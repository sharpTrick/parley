import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asCursor, asTopic, type Cursor } from '../message.js';
import { defaultReadStatePath, ReadStateStore } from './read-state.js';

const tmpFile = () => join(mkdtempSync(join(tmpdir(), 'parley-rs-')), 'read-state.json');

describe('ReadStateStore', () => {
  it('returns undefined for an unread topic', () => {
    const s = new ReadStateStore(tmpFile());
    expect(s.get(asTopic('x'))).toBeUndefined();
  });

  it('persists and reloads across instances', () => {
    const path = tmpFile();
    new ReadStateStore(path).set(asTopic('t'), asCursor('42'));
    expect(new ReadStateStore(path).get(asTopic('t'))).toBe('42');
  });

  it('writes valid JSON atomically', () => {
    const path = tmpFile();
    const s = new ReadStateStore(path);
    s.set(asTopic('t1'), asCursor('1'));
    s.set(asTopic('t2'), asCursor('2'));
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ t1: '1', t2: '2' });
  });

  it('tolerates a corrupt file (starts empty)', () => {
    const path = tmpFile();
    writeFileSync(path, 'not json at all', 'utf8');
    expect(new ReadStateStore(path).get(asTopic('t'))).toBeUndefined();
  });

  it('does not lose writes when the file is a JSON array', () => {
    const path = tmpFile();
    writeFileSync(path, '[]', 'utf8');
    new ReadStateStore(path).set(asTopic('t'), asCursor('c'));
    expect(new ReadStateStore(path).get(asTopic('t'))).toBe('c');
  });

  /**
   * `load` already refuses a non-string cursor because one would wedge catch-up — but the WRITE side
   * took anything, and `undefined` is the shape a plugin that returns no `nextCursor` actually hands
   * over. `JSON.stringify` omits an undefined value, so that write deleted the topic's key on disk:
   * the position was not merely stale on the next boot, it was gone, and the topic cold-restarted.
   * Table the value shapes both sides can see and require the same verdict from each, so a new one
   * cannot be accepted by one side and discarded by the other.
   */
  describe('a cursor that load() would refuse is refused by set() too', () => {
    const SHAPES: Array<[label: string, value: unknown, accepted: boolean]> = [
      ['a plain string', '43', true],
      ['a string that looks numeric but is one', '0', true],
      ['undefined (no nextCursor at all)', undefined, false],
      ['null', null, false],
      ['a number', 44, false],
      ['an empty string', '', false],
      ['an object', { a: 1 }, false],
    ];

    it.each(SHAPES)('%s', (_label, value, accepted) => {
      const path = tmpFile();
      const T = asTopic('ctx');
      const store = new ReadStateStore(path);
      store.set(T, asCursor('42'));

      const write = () => store.set(T, value as Cursor);
      if (accepted) {
        write();
        expect(new ReadStateStore(path).get(T)).toBe(value);
        return;
      }
      expect(write).toThrow(TypeError);
      // The previously persisted position must survive in memory AND on disk — a refused write may
      // never leave the topic worse off than not writing at all.
      expect(store.get(T)).toBe('42');
      expect(new ReadStateStore(path).get(T)).toBe('42');
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ ctx: '42' });
    });
  });

  it('drops non-string cursor values at load', () => {
    const path = tmpFile();
    writeFileSync(path, '{"t":{"a":1}}', 'utf8');
    const s = new ReadStateStore(path);
    expect(s.get(asTopic('t'))).toBeUndefined();
    // A sibling topic still persists correctly afterwards.
    s.set(asTopic('t2'), asCursor('ok'));
    expect(new ReadStateStore(path).get(asTopic('t2'))).toBe('ok');
  });

  it('handles __proto__/constructor topic names without prototype leakage', () => {
    const path = tmpFile();
    const s = new ReadStateStore(path);
    expect(s.get(asTopic('constructor'))).toBeUndefined();
    expect(s.get(asTopic('__proto__'))).toBeUndefined();
    s.set(asTopic('__proto__'), asCursor('p'));
    expect(new ReadStateStore(path).get(asTopic('__proto__'))).toBe('p');
    // Global prototype was not mutated by the write.
    expect(Object.getPrototypeOf({})).toBe(Object.prototype);
  });

  /**
   * "Per-instance" is a naming convention, not an enforced lock: `instance_id` defaults to the
   * handle, so two concurrent sessions of one agent share a file by DEFAULT. Table the ways two
   * stores can land on one path against the write orders they can interleave in, and require that
   * neither session's cursors vanish — losing them silently re-runs cold-start catch-up.
   */
  describe('two stores on one path never erase each other', () => {
    const realStateHome = process.env.XDG_STATE_HOME;
    afterEach(() => {
      if (realStateHome === undefined) delete process.env.XDG_STATE_HOME;
      else process.env.XDG_STATE_HOME = realStateHome;
    });

    const paths: Array<[name: string, make: () => string]> = [
      ['an explicit shared state_path', () => tmpFile()],
      [
        'the default path for one instanceId (instance_id defaults to the handle)',
        () => {
          process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'parley-rs-xdg-'));
          return defaultReadStatePath('agent');
        },
      ],
    ];

    /** One store's write. The store label is what makes two sessions distinguishable. */
    type Step = [store: 'a' | 'b', topic: string, cursor: string];

    /**
     * TOPIC OVERLAP is the axis that matters, and the original table had none: every row wrote
     * DISJOINT topics, so a flush that republished this store's whole in-memory map looked correct.
     * The regression only shows when two stores touch the SAME topic and one of them then flushes an
     * unrelated third — the flush rolls the shared topic back to where this store last read it.
     */
    const SHAPES: Array<[name: string, steps: Step[]]> = [
      ['disjoint topics', [['a', 'ctx', '10'], ['b', 'ops', '5']]],
      ['the same topic', [['a', 'ctx', '10'], ['b', 'ctx', '20']]],
      [
        'the same topic, then an unrelated third',
        [['a', 'ctx', '10'], ['b', 'ctx', '20'], ['a', 'notes', '7']],
      ],
      [
        'the same topic advanced by both, alternating',
        [['a', 'ctx', '10'], ['b', 'ctx', '20'], ['a', 'ctx', '30'], ['b', 'ops', '4']],
      ],
    ];

    const ORDERS: Array<[name: string, arrange: (steps: Step[]) => Step[]]> = [
      ['in order', (steps) => steps],
      ['reversed', (steps) => [...steps].reverse()],
      // Each store flushes an earlier position for every topic first, so the two stores' writes
      // interleave rather than running as two clean halves.
      ['interleaved with earlier positions', (steps) => [...steps.map(([s, t, c]) => [s, t, `0${c}`] as Step), ...steps]],
    ];

    for (const [shapeName, steps] of SHAPES) {
      for (const [orderName, arrange] of ORDERS) {
        it(`${shapeName}, written ${orderName}`, () => {
          const path = tmpFile();
          const stores = { a: new ReadStateStore(path), b: new ReadStateStore(path) };
          const expected: Record<string, string> = {};
          for (const [store, topic, cursor] of arrange(steps)) {
            stores[store].set(asTopic(topic), asCursor(cursor));
            expected[topic] = cursor; // last writer wins, per topic — the strongest correct rule
          }
          // The WHOLE map, not two known keys: nothing may hold a value older than the last one
          // written to it, and no topic may vanish.
          expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expected);
          const reopened = new ReadStateStore(path);
          for (const [topic, cursor] of Object.entries(expected)) {
            expect(reopened.get(asTopic(topic))).toBe(cursor);
          }
        });
      }
    }

    it.each(paths)('two stores on %s keep both positions', (_name, make) => {
      const path = make();
      const a = new ReadStateStore(path);
      const b = new ReadStateStore(path);
      a.set(asTopic('ctx'), asCursor('10'));
      b.set(asTopic('ops'), asCursor('5'));
      const reopened = new ReadStateStore(path);
      expect(reopened.get(asTopic('ctx'))).toBe('10');
      expect(reopened.get(asTopic('ops'))).toBe('5');
    });

    it('distinct instanceIds stay fully independent', () => {
      process.env.XDG_STATE_HOME = mkdtempSync(join(tmpdir(), 'parley-rs-xdg-'));
      const a = new ReadStateStore(defaultReadStatePath('sess-a'));
      const b = new ReadStateStore(defaultReadStatePath('sess-b'));
      a.set(asTopic('ctx'), asCursor('10'));
      b.set(asTopic('ctx'), asCursor('99'));
      expect(new ReadStateStore(defaultReadStatePath('sess-a')).get(asTopic('ctx'))).toBe('10');
      expect(new ReadStateStore(defaultReadStatePath('sess-b')).get(asTopic('ctx'))).toBe('99');
    });

    // A shared temp filename lets one flush interleave into another's half-written bytes, which
    // load() then silently discards as "corrupt" — a whole read-state reset. Occupying the fixed
    // name with a DIRECTORY makes any writer still using it fail loudly (EISDIR).
    it('does not write through a temp name another store on this path would also use', () => {
      const path = tmpFile();
      mkdirSync(`${path}.tmp`);
      const s = new ReadStateStore(path);
      s.set(asTopic('ctx'), asCursor('1'));
      expect(new ReadStateStore(path).get(asTopic('ctx'))).toBe('1');
    });

    /**
     * The shipped README sizes this hazard for the operator deciding whether two sessions may run
     * at once, and it described a blast radius the implementation had already narrowed — a whole
     * session's catch-up position clobbered, rather than one contended topic. Prose and code drift
     * because nothing connects them, so the sentence and the behaviour are graded together: state
     * the claim as a phrase the README must carry, and as the test that would fail if the guarantee
     * ever widened back.
     */
    describe('a shared instance_id races per topic, not per session', () => {
      const CLAIM = 'the loser re-reads or skips messages on the contended topic only';

      it(`the README says exactly that: "${CLAIM}"`, () => {
        const readme = readFileSync(fileURLToPath(new URL('../../README.md', import.meta.url)), 'utf8');
        const paragraph = /`instance_id`[\s\S]*?\n\n/.exec(readme)?.[0] ?? '';
        expect(paragraph.replace(/\s+/g, ' ')).toContain(CLAIM);
      });

      it('positions on topics a session advanced ALONE all survive', () => {
        const path = tmpFile();
        const a = new ReadStateStore(path);
        const b = new ReadStateStore(path);
        a.set(asTopic('a1'), asCursor('1'));
        b.set(asTopic('b1'), asCursor('2'));
        a.set(asTopic('a2'), asCursor('3'));
        b.set(asTopic('b2'), asCursor('4'));
        expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual({ a1: '1', b1: '2', a2: '3', b2: '4' });
      });

      it('a contended topic keeps one of the two cursors, in a file that is still valid JSON', () => {
        const path = tmpFile();
        const a = new ReadStateStore(path);
        const b = new ReadStateStore(path);
        a.set(asTopic('solo-a'), asCursor('9'));
        a.set(asTopic('c'), asCursor('10'));
        b.set(asTopic('c'), asCursor('20'));
        b.set(asTopic('solo-b'), asCursor('8'));
        const onDisk = JSON.parse(readFileSync(path, 'utf8')) as Record<string, string>;
        expect(['10', '20']).toContain(onDisk['c']);
        expect(onDisk['solo-a']).toBe('9'); // the contended topic costs nothing outside itself
        expect(onDisk['solo-b']).toBe('8');
      });
    });
  });

  /**
   * The temp name is deliberately process-unique so concurrent flushes cannot interleave — which
   * also means nothing ever collides with, overwrites, or cleans up an orphan. Catch-up flushes
   * once per page per topic, so a directory that fails the write accumulates them without bound.
   * Table the ways an atomic-rename writer can fail and require, in every one, that `set()` throws
   * AND that the directory gained no `.tmp` entry.
   */
  describe('a failed atomic write leaves no debris', () => {
    interface WriteFailure {
      name: string;
      make: (dir: string) => string;
      /** Undo the condition, so the SAME store's next flush succeeds. */
      heal: (path: string) => void;
    }

    const failures: WriteFailure[] = [
      {
        name: 'the rename target is a directory',
        make: (dir) => {
          const target = join(dir, 'read-state.json');
          mkdirSync(target);
          writeFileSync(join(target, 'occupant'), 'x', 'utf8');
          return target;
        },
        heal: (path) => rmSync(path, { recursive: true }),
      },
      {
        name: 'the rename target is an empty directory',
        make: (dir) => {
          const target = join(dir, 'read-state.json');
          mkdirSync(target);
          return target;
        },
        heal: (path) => rmSync(path, { recursive: true }),
      },
      {
        name: 'the state directory path is a regular file',
        make: (dir) => {
          const blocker = join(dir, 'notadir');
          writeFileSync(blocker, 'x', 'utf8');
          return join(blocker, 'read-state.json');
        },
        heal: (path) => rmSync(dirname(path)),
      },
    ];

    const tmpEntries = (dir: string): string[] =>
      readdirSync(dir, { recursive: true })
        .map((e) => String(e))
        .filter((e) => e.endsWith('.tmp'));

    it.each(failures.map((f) => [f.name, f] as const))('%s', (_name, f) => {
      const dir = mkdtempSync(join(tmpdir(), 'parley-rs-fail-'));
      const path = f.make(dir);
      const store = new ReadStateStore(path);
      expect(() => store.set(asTopic('t'), asCursor('1'))).toThrow();
      expect(tmpEntries(dir)).toEqual([]);
      // A repeated attempt (catch-up retries page by page) still deposits nothing.
      expect(() => store.set(asTopic('t'), asCursor('2'))).toThrow();
      expect(tmpEntries(dir)).toEqual([]);
    });

    /**
     * A flush that fails must leave its topics PENDING: the next successful flush is what finally
     * publishes them. Clearing the pending set unconditionally passes the debris table above
     * unchanged, and only shows up here — the failed topic never reaches disk at all, so a later
     * flush for an unrelated topic quietly publishes a file that is missing a read position.
     */
    it.each(
      failures.flatMap((f) =>
        [1, 2].flatMap((attempts) =>
          (['the same topic', 'a different topic'] as const).map(
            (retry) => [`${f.name}, ${attempts} failed write(s), retried on ${retry}`, f, attempts, retry] as const,
          ),
        ),
      ),
    )('%s', (_name, f, attempts, retry) => {
      const dir = mkdtempSync(join(tmpdir(), 'parley-rs-heal-'));
      const path = f.make(dir);
      const store = new ReadStateStore(path);
      for (let i = 1; i <= attempts; i++) {
        expect(() => store.set(asTopic('blocked'), asCursor(`b${i}`))).toThrow();
      }
      f.heal(path);
      store.set(asTopic(retry === 'the same topic' ? 'blocked' : 'other'), asCursor('ok'));

      const expected =
        retry === 'the same topic' ? { blocked: 'ok' } : { blocked: `b${attempts}`, other: 'ok' };
      expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(expected);
      expect(new ReadStateStore(path).get(asTopic('blocked'))).toBe(expected.blocked);
      expect(tmpEntries(dir)).toEqual([]);
    });

    it('a successful write leaves no temp file behind either', () => {
      const dir = mkdtempSync(join(tmpdir(), 'parley-rs-ok-'));
      const path = join(dir, 'read-state.json');
      new ReadStateStore(path).set(asTopic('t'), asCursor('1'));
      expect(tmpEntries(dir)).toEqual([]);
    });
  });

  /**
   * `state_path` is an OPTIONAL string, so an empty override sails past `??` and becomes the path.
   * Every downstream failure is then an unactionable ENOENT naming a random dotfile, so refuse it
   * where the path is adopted.
   */
  it('refuses an empty path instead of adopting it', () => {
    expect(() => new ReadStateStore('')).toThrow(/state_path/);
  });

  it('default path is namespaced by instanceId', () => {
    const p = defaultReadStatePath('ctx-payments');
    expect(p).toContain('parley');
    expect(p).toContain('ctx-payments');
    expect(p.endsWith('read-state.json')).toBe(true);
  });

  /**
   * `instance_id` defaults to identity.handle, so any handle carrying a separator or a traversal
   * token reshapes the on-disk layout: the state file lands OUTSIDE `parley/`, or silently nests
   * itself in directories nobody configured. Table hostile ids against the invariants that make the
   * mapping safe — one namespace component, under `parley/`, never `.`/`..`, and injective — so the
   * character-class sanitizer cannot be narrowed or dropped while the suite stays green.
   */
  describe('a hostile instanceId can neither escape parley/ nor collide', () => {
    const HOSTILE: Array<[label: string, id: string]> = [
      ['a traversal token', '..'],
      ['the current directory', '.'],
      ['an empty id', ''],
      ['a rooted traversal', '../../etc'],
      ['an interior traversal', 'a/../../b'],
      ['windows separators', 'a\\..\\b'],
      ['a NUL byte', '.\u0000/x'],
      ['a bare separator', '/'],
      ['a trailing separator', 'sess/'],
      ['a reserved device name', 'con'],
      ['a 4KB id', 'x'.repeat(4_096)],
      ['a unicode division slash', 'a\u2215b'],
      ['a newline', 'a\nb'],
      ['a plain id (the control)', 'ctx-payments'],
    ];

    it.each(HOSTILE)('%s becomes one namespace component under parley/', (_label, id) => {
      const parts = normalize(defaultReadStatePath(id)).split(sep);
      expect(parts.at(-1)).toBe('read-state.json');
      expect(parts.at(-3)).toBe('parley'); // nothing between parley/ and the file but the namespace
      const namespace = parts.at(-2)!;
      expect(namespace).not.toBe('');
      expect(namespace).not.toBe('.');
      expect(namespace).not.toBe('..');
      expect(namespace).not.toMatch(/[\\/]/);
    });

    it('distinct ids never share a file, however they clean up', () => {
      const ids = [...HOSTILE.map(([, id]) => id), 'a/b', 'a_b', 'sess/1', 'sess_1'];
      const paths = ids.map((id) => defaultReadStatePath(id));
      expect(new Set(paths).size).toBe(new Set(ids).size);
    });
  });

  // A co-tenant on a shared host must not be able to read this instance's cursor positions.
  it('creates read-state.json 0600 and its dir 0700', () => {
    const base = mkdtempSync(join(tmpdir(), 'parley-rs-mode-'));

    // Control: a plain mkdir under this env's umask reproduces the pre-fix dir mode. If it is not
    // world/group-traversable (e.g. umask 0077) the 0700 assertion below would be trivially met,
    // so skip the strict check in that case rather than claim a false proof.
    const control = join(base, 'control');
    mkdirSync(control);
    const umaskExposes = (statSync(control).mode & 0o077) !== 0;

    // Point at a path whose parent dir does NOT exist yet, so flush()'s mkdirSync is what creates
    // it — otherwise we'd be asserting on mkdtemp's own 0700 rather than the fix.
    const dir = join(base, 'nested');
    const file = join(dir, 'read-state.json');
    new ReadStateStore(file).set(asTopic('t'), asCursor('1'));

    expect(dirname(file)).toBe(dir);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dir).mode & 0o777).toBe(0o700);
    if (umaskExposes) {
      // The fix stripped the group/other bits a plain mkdir/writeFile would have left.
      expect(statSync(control).mode & 0o077).not.toBe(0);
    }
  });
});
