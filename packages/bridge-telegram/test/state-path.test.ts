import { describe, expect, it } from 'vitest';
import { defaultStorePath } from '../src/config.js';

/**
 * CLASS: two absent values, one of them accepted. `??` stands in for undefined only, so
 * `XDG_STATE_HOME` set to the empty string reached `join()` as a path segment and the default store
 * resolved RELATIVE to the spawn directory — the one thing the function's own doc comment forbids,
 * because a bridge relaunched from another working directory would then start a fresh sequence
 * space underneath cursors an agent is still holding.
 */
describe('the default store path treats every absent XDG_STATE_HOME the same way', () => {
  const withEnv = <T>(value: string | undefined, run: () => T): T => {
    const before = process.env['XDG_STATE_HOME'];
    if (value === undefined) delete process.env['XDG_STATE_HOME'];
    else process.env['XDG_STATE_HOME'] = value;
    try {
      return run();
    } finally {
      if (before === undefined) delete process.env['XDG_STATE_HOME'];
      else process.env['XDG_STATE_HOME'] = before;
    }
  };

  it.each([
    ['unset', undefined],
    ['empty', ''],
    ['whitespace', '   '],
    ['relative, which the XDG spec says to ignore', 'relative/state'],
  ] as ReadonlyArray<readonly [label: string, value: string | undefined]>)(
    'reads %s as the default',
    (_label, value) => {
      const path = withEnv(value, defaultStorePath);
      expect(path, `${JSON.stringify(value)} produced a path under the working directory`).toBe(
        withEnv(undefined, defaultStorePath),
      );
    },
  );

  it('follows an absolute value it is given', () => {
    expect(withEnv('/somewhere/state', defaultStorePath)).toBe(
      '/somewhere/state/parley/telegram/observed.jsonl',
    );
  });
});
