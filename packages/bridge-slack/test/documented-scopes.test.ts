/**
 * CLASS: the documented required scopes must equal the scopes the code actually exercises.
 *
 * A scope in the provisioning list that no call needs is not free — operators grant it, and it
 * widens what a leaked `xoxb-` token can do (DESIGN §14). A call whose scope is undocumented is
 * worse: the bridge fails at runtime with a `missing_scope` nobody can map back. Both directions
 * are the same invariant, so this compares the Web API methods reachable from `src/` against the
 * README's method→scope table and requires equality.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/** Every `this.api<…>('<method>'…)` call site in the plugin source. */
function methodsCalledInSource(): Set<string> {
  const src = read('../src/index.ts');
  return new Set([...src.matchAll(/this\.api<[^(]*>\(\s*'([^']+)'/g)].map((m) => m[1]!));
}

/** The README's scope table, as method → the scope cell next to it. */
function scopeTable(): Map<string, string> {
  const readme = read('../README.md');
  const rows = readme.matchAll(/^\s*\|\s*`([a-z]+\.[a-zA-Z.]+)`\s*\|([^|]*)\|/gm);
  return new Map([...rows].map((m) => [m[1]!, m[2]!.trim()]));
}

describe('slack provisioning docs', () => {
  it('the README scope table names exactly the Web API methods the plugin calls', () => {
    const called = [...methodsCalledInSource()].sort();
    const documented = [...scopeTable().keys()].sort();
    expect(called.length).toBeGreaterThan(0);
    expect(documented).toEqual(called);
  });

  it('asks for no listing/discovery scope, because no listing method is called', () => {
    // `channels:read` grants workspace-wide channel enumeration; topics are mapped by config.
    for (const [method, scope] of scopeTable()) {
      expect(method).not.toMatch(/\.list$/);
      expect(scope).not.toMatch(/channels:read/);
    }
  });
});
