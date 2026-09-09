import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { workspaceRoot } from '@sharptrick/parley-net-util/testing';
import { afterAll, describe, expect, it } from 'vitest';
import { asCursor, asTopic } from '../message.js';
import { defaultReadStatePath, ReadStateStore } from './read-state.js';

/**
 * CLASS: a documented file set that nothing drives. DESIGN §10 said core writes "four, all under
 * the one configured path" while the flush path also writes `<state_path>.<pid>.<uuid>.tmp`, which
 * nothing cleans up after a process dies mid-write, and README named "three siblings" and then
 * listed two. Neither count was reachable from any test.
 *
 * So the table is not read as prose: the names are parsed out of it and compared against what a
 * REAL store leaves on disk after each failure the table documents.
 */
const DESIGN = readFileSync(join(workspaceRoot(), 'DESIGN.md'), 'utf8');

/** The first column of the `state_path` table in DESIGN §10, as file names. */
const documentedNames = (): string[] => {
  const table = /\| File \| Holds \| If you delete it \|\n\|[-| ]+\|\n((?:\|.*\n)+)/.exec(DESIGN);
  if (table === null) throw new Error('DESIGN.md no longer carries the `state_path` file table');
  return table[1]!
    .trim()
    .split('\n')
    .map((row) => row.split('|')[1]!.trim().replace(/^`|`$/g, ''));
};

const STATE_FILE = 'read-state.json';

const ROOT = mkdtempSync(join(tmpdir(), 'parley-state-files-'));
afterAll(() => rmSync(ROOT, { recursive: true, force: true }));

let made = 0;
const sandbox = (): string => {
  const dir = join(ROOT, `case-${made++}`);
  mkdirSync(dir);
  return dir;
};

/** A file on disk under the state directory, in the spelling the table uses. */
const asDocumentedName = (file: string): string =>
  file.replace(STATE_FILE, '<state_path>').replace(/\.\d+\.[0-9a-f-]+\.tmp$/, '.<pid>.<uuid>.tmp');

const topic = asTopic('room');
const cursor = asCursor('c1');

describe('the files core writes under state_path are the files DESIGN §10 lists', () => {
  it('parses names out of the table rather than trusting the sentence above it', () => {
    expect(documentedNames()).toContain('<state_path>');
    expect(documentedNames().length).toBeGreaterThan(3);
  });

  it('leaves exactly the persistent names the table lists, and no others', () => {
    const observed = new Set<string>();
    const collect = (dir: string): void => {
      for (const file of readdirSync(dir)) observed.add(asDocumentedName(file));
    };

    const clean = sandbox();
    const store = new ReadStateStore(join(clean, STATE_FILE));
    store.set(topic, cursor);
    store.markWarmed(topic, cursor);
    collect(clean);

    const corruptPosition = sandbox();
    writeFileSync(join(corruptPosition, STATE_FILE), 'not json');
    const quarantined = new ReadStateStore(join(corruptPosition, STATE_FILE));
    quarantined.set(topic, cursor);
    collect(corruptPosition);

    const corruptMarker = sandbox();
    writeFileSync(join(corruptMarker, `${STATE_FILE}.warmed`), '[]');
    const warm = new ReadStateStore(join(corruptMarker, STATE_FILE));
    warm.warmedThrough(topic);
    warm.markWarmed(topic, cursor);
    collect(corruptMarker);

    const unwritable = sandbox();
    const denied = new ReadStateStore(join(unwritable, 'nested', STATE_FILE));
    rmSync(join(unwritable), { recursive: true, force: true });
    mkdirSync(unwritable, { mode: 0o500 });
    denied.markWarmed(topic, cursor);
    collect(unwritable);

    expect(
      [...observed].sort(),
      'the state directory holds names DESIGN §10 does not list, or the table lists names no ' +
        'documented failure produces — an operator cleaning up cannot tell which files are theirs',
    ).toEqual(documentedNames().filter((name) => !name.includes('<pid>')).sort());
  });

  /**
   * The transient name, which no `readdirSync` after the fact can see: the write is renamed into
   * place, and a failed one is unlinked. A rename ONTO A DIRECTORY fails, and the failure names the
   * temp file — the only place the spelling is observable from outside the module.
   */
  it('writes through the transient name the table documents', () => {
    const documented = documentedNames().find((name) => name.includes('<pid>'));
    expect(documented, 'DESIGN §10 no longer documents a transient write name').toBeDefined();
    const spelling = new RegExp(
      documented!
        .replace('<state_path>', STATE_FILE.replaceAll('.', '\\.'))
        .replace('.<pid>', '\\.\\d+')
        .replace('.<uuid>', '\\.[0-9a-f-]+')
        .replace('.tmp', '\\.tmp'),
    );

    const dir = sandbox();
    mkdirSync(join(dir, STATE_FILE));
    writeFileSync(join(dir, STATE_FILE, 'occupant'), 'x');
    const store = new ReadStateStore(join(dir, STATE_FILE));
    let failure = '';
    try {
      store.set(topic, cursor);
    } catch (err) {
      failure = err instanceof Error ? err.message : String(err);
    }
    expect(failure, 'a flush onto an occupied path should fail naming its temp file').not.toEqual('');
    expect(failure, `${failure} does not carry ${documented}`).toMatch(spelling);
  });
});

/**
 * CLASS: two absent values, one of them accepted. `??` only stands in for undefined, so an env var
 * set to the empty string (or to spaces) reached `join()` as a path segment and the "default" state
 * file resolved RELATIVE to wherever the bridge was spawned — a fresh state file beside cursors an
 * agent is still holding. The XDG spec reads unset and empty the same way, and requires an absolute
 * value; the shell spelling in the doc comment, `${XDG_STATE_HOME:-…}`, already said so.
 */
describe('an optional env path treats every absent value the same way', () => {
  const ABSENT: ReadonlyArray<readonly [label: string, value: string | undefined]> = [
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['relative, which the XDG spec says to ignore', 'relative/state'],
  ];

  it.each(ABSENT)('reads %s as the default', (_label, value) => {
    const before = process.env['XDG_STATE_HOME'];
    try {
      if (value === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = value;
      const path = defaultReadStatePath('probe');
      expect(path, `${JSON.stringify(value)} produced a path under the working directory`).toBe(
        defaultAway(),
      );
    } finally {
      if (before === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = before;
    }
  });

  /** What the default has to be, computed the way the doc comment states it. */
  const defaultAway = (): string => {
    const before = process.env['XDG_STATE_HOME'];
    delete process.env['XDG_STATE_HOME'];
    try {
      return defaultReadStatePath('probe');
    } finally {
      if (before !== undefined) process.env['XDG_STATE_HOME'] = before;
    }
  };
});
