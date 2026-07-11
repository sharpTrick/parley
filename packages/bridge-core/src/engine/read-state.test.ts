import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, normalize, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
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

  // BUG-33 — an array file must not swallow subsequent writes.
  it('does not lose writes when the file is a JSON array', () => {
    const path = tmpFile();
    writeFileSync(path, '[]', 'utf8');
    new ReadStateStore(path).set(asTopic('t'), asCursor('c'));
    expect(new ReadStateStore(path).get(asTopic('t'))).toBe('c');
  });

  // BUG-33 — a non-string cursor value is filtered out at load (catch-up starts fresh).
  it('drops non-string cursor values at load', () => {
    const path = tmpFile();
    writeFileSync(path, '{"t":{"a":1}}', 'utf8');
    const s = new ReadStateStore(path);
    expect(s.get(asTopic('t'))).toBeUndefined();
    // A sibling topic still persists correctly afterwards.
    s.set(asTopic('t2'), asCursor('ok'));
    expect(new ReadStateStore(path).get(asTopic('t2'))).toBe('ok');
  });

  // BUG-33 — prototype-pollution topic names leak nothing and round-trip like any other.
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

  it('default path is namespaced by instanceId', () => {
    const p = defaultReadStatePath('ctx-payments');
    expect(p).toContain('parley');
    expect(p).toContain('ctx-payments');
    expect(p.endsWith('read-state.json')).toBe(true);
  });

  // BUG-42 — the sanitized path never escapes the parley/ dir via a traversal token.
  it('does not let instanceId ".." escape the parley/ dir', () => {
    const p = defaultReadStatePath('..');
    expect(p).not.toContain(`${sep}..${sep}`);
    expect(normalize(p)).toContain(`${sep}parley${sep}`);
  });

  // BUG-42 — distinct ids that clean to the same string map to distinct files.
  it('maps distinct ids that clean alike to distinct files', () => {
    expect(defaultReadStatePath('a/b')).not.toBe(defaultReadStatePath('a_b'));
    expect(defaultReadStatePath('sess/1')).not.toBe(defaultReadStatePath('sess_1'));
  });

  // SEC-16 — flush() must create read-state.json 0600 and its containing dir 0700 so a co-tenant
  // on a shared host cannot read this instance's cursor positions. Pre-fix these landed at the
  // umask default (0644/0755).
  it('creates read-state.json 0600 and its dir 0700 (SEC-16)', () => {
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
