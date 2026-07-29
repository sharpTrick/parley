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

/**
 * Every `this.api(…)` call site in a source, as its literal method name.
 *
 * A guard that scans source can stop matching without failing, so this extractor is deliberately
 * strict rather than permissive: it accepts a call with or without a type argument, and THROWS on a
 * call whose method name is not a plain single-quoted literal. A shape it cannot read is a loud
 * failure, never a silent omission that leaves an undocumented scope invisible.
 */
function methodsCalledIn(src: string): Set<string> {
  const found = new Set<string>();
  const sites = [...src.matchAll(/this\.api\b(<[^(]*>)?\s*\(\s*([^,)]*)/g)];
  for (const site of sites) {
    const firstArg = site[2]!.trim();
    const literal = /^'([^']+)'$/.exec(firstArg);
    if (literal === null) {
      throw new Error(`unreadable this.api call site — method name is not a string literal: ${firstArg}`);
    }
    found.add(literal[1]!);
  }
  return found;
}

const methodsCalledInSource = (): Set<string> => methodsCalledIn(read('../src/index.ts'));

/** The README's scope table, as method → the scope cell next to it. */
function scopeTable(): Map<string, string> {
  const readme = read('../README.md');
  const rows = readme.matchAll(/^\s*\|\s*`([a-z]+\.[a-zA-Z.]+)`\s*\|([^|]*)\|/gm);
  return new Map([...rows].map((m) => [m[1]!, m[2]!.trim()]));
}

describe('slack provisioning docs', () => {
  // CLASS: a source-scanning guard that can stop matching without failing. Both extractors are
  // driven over fixtures covering every shape they must read, so a refactor that makes them blind
  // fails HERE rather than quietly greening the parity check below with two empty sets.
  it('the call-site extractor reads every call shape, and refuses the ones it cannot', () => {
    expect(
      methodsCalledIn(`
        await this.api<{ ok: boolean }>('typed.method', {});
        await this.api('untyped.method', {});
        await this.api<Foo>(
          'multiline.method',
          { a: 1 },
        );
        await this.api<{ ok: boolean; user: { id: string } }>('nested.generic', {}, 'app');
      `),
    ).toEqual(new Set(['typed.method', 'untyped.method', 'multiline.method', 'nested.generic']));

    expect(() => methodsCalledIn("this.api(`conversations.${kind}`, {})")).toThrow(/not a string literal/);
    expect(() => methodsCalledIn('this.api(method, {})')).toThrow(/not a string literal/);
  });

  it('the README scope table names exactly the Web API methods the plugin calls', () => {
    const called = [...methodsCalledInSource()].sort();
    const documented = [...scopeTable().keys()].sort();
    // Both sides non-empty: an equality between two empty sets is not a parity check.
    expect(called).toContain('conversations.history');
    expect(documented.length).toBeGreaterThan(0);
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
