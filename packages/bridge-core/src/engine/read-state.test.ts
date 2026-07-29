import { mkdirSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { asCursor, asTopic } from '../message.js';
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

    const orders: Array<[name: string, run: (a: ReadStateStore, b: ReadStateStore) => void]> = [
      [
        'sequential',
        (a, b) => {
          a.set(asTopic('ctx'), asCursor('10'));
          b.set(asTopic('ops'), asCursor('5'));
        },
      ],
      [
        'interleaved',
        (a, b) => {
          a.set(asTopic('ctx'), asCursor('1'));
          b.set(asTopic('ops'), asCursor('2'));
          a.set(asTopic('ctx'), asCursor('10'));
          b.set(asTopic('ops'), asCursor('5'));
        },
      ],
      [
        'reversed',
        (a, b) => {
          b.set(asTopic('ops'), asCursor('5'));
          a.set(asTopic('ctx'), asCursor('10'));
        },
      ],
    ];

    for (const [pathName, make] of paths) {
      for (const [orderName, run] of orders) {
        it(`${pathName}, written ${orderName}`, () => {
          const path = make();
          const a = new ReadStateStore(path);
          const b = new ReadStateStore(path);
          run(a, b);
          const reopened = new ReadStateStore(path);
          expect(reopened.get(asTopic('ctx'))).toBe('10');
          expect(reopened.get(asTopic('ops'))).toBe('5');
        });
      }
    }

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
  });

  /**
   * The temp name is deliberately process-unique so concurrent flushes cannot interleave — which
   * also means nothing ever collides with, overwrites, or cleans up an orphan. Catch-up flushes
   * once per page per topic, so a directory that fails the write accumulates them without bound.
   * Table the ways an atomic-rename writer can fail and require, in every one, that `set()` throws
   * AND that the directory gained no `.tmp` entry.
   */
  describe('a failed atomic write leaves no debris', () => {
    const failures: Array<[name: string, make: (dir: string) => string]> = [
      [
        'the rename target is a directory',
        (dir) => {
          const target = join(dir, 'read-state.json');
          mkdirSync(target);
          writeFileSync(join(target, 'occupant'), 'x', 'utf8');
          return target;
        },
      ],
      [
        'the rename target is an empty directory',
        (dir) => {
          const target = join(dir, 'read-state.json');
          mkdirSync(target);
          return target;
        },
      ],
      [
        'the state directory path is a regular file',
        (dir) => {
          const blocker = join(dir, 'notadir');
          writeFileSync(blocker, 'x', 'utf8');
          return join(blocker, 'read-state.json');
        },
      ],
    ];

    const tmpEntries = (dir: string): string[] =>
      readdirSync(dir, { recursive: true })
        .map((e) => String(e))
        .filter((e) => e.endsWith('.tmp'));

    it.each(failures)('%s', (_name, make) => {
      const dir = mkdtempSync(join(tmpdir(), 'parley-rs-fail-'));
      const path = make(dir);
      const store = new ReadStateStore(path);
      expect(() => store.set(asTopic('t'), asCursor('1'))).toThrow();
      expect(tmpEntries(dir)).toEqual([]);
      // A repeated attempt (catch-up retries page by page) still deposits nothing.
      expect(() => store.set(asTopic('t'), asCursor('2'))).toThrow();
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
