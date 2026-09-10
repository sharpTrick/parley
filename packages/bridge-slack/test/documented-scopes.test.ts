/**
 * CLASS: prose that restates something the code owns must be checked against the code — EVERY
 * column of it, not the columns that were easy to grade.
 *
 * The documented required scopes must equal the scopes the code actually exercises. A scope in the
 * provisioning list that no call needs is not free — operators grant it, and it widens what a leaked
 * `xoxb-` token can do (DESIGN §14). A call whose scope is undocumented is worse: the bridge fails
 * at runtime with a `missing_scope` nobody can map back. The table's third column — which seam
 * method sends the call — is graded on the same footing, by reachability.
 */
import { TIMER_CONFIG_KEYS } from '../src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { slackSourceModules } from './source-tree.js';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

/**
 * The text of every module the BUILD compiles, at whatever depth it sits — see
 * {@link slackSourceModules}, which derives the set from `tsconfig.json` rather than by listing a
 * directory, so that moving a call site between modules, or down into a subdirectory, cannot leave
 * a parity check below grading a set the shipped `dist/` is larger than.
 */
const sourceModules = (): string[] => slackSourceModules().map((m) => m.text);

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

const methodsCalledInSource = (): Set<string> =>
  new Set(sourceModules().flatMap((text) => [...methodsCalledIn(text)]));

/** One documented row: the scope cell, and the seam methods the 'Used by' cell names. */
interface ScopeRow {
  scope: string;
  usedBy: string[];
}

/** The README's scope table, as method → its row. */
function scopeTable(): Map<string, ScopeRow> {
  const readme = read('../README.md');
  const rows = readme.matchAll(/^\s*\|\s*`([a-z]+\.[a-zA-Z.]+)`\s*\|([^|]*)\|([^|]*)\|/gm);
  return new Map(
    [...rows].map((m) => [
      m[1]!,
      { scope: m[2]!.trim(), usedBy: [...m[3]!.matchAll(/`(\w+)`/g)].map((c) => c[1]!) },
    ]),
  );
}

/** Every exported class body in a source — the seam's own, and each piece it composes. */
const classBodies = (src: string): string[] =>
  [...src.matchAll(/\nexport class \w+[^{]*\{\n([\s\S]*?)\n\}\n/g)].map((m) => m[1]!);

/**
 * The body of the seam class, found by the interface it implements rather than by the file it sits
 * in: "a seam method" means a public method of THAT class, and no other.
 */
function seamClassBody(): string {
  const bodies = sourceModules().flatMap((src) =>
    [...src.matchAll(/\nexport class \w+ implements BackendPlugin \{\n([\s\S]*?)\n\}\n/g)].map(
      (m) => m[1]!,
    ),
  );
  expect(bodies, 'src/ has exactly one class implementing BackendPlugin').toHaveLength(1);
  return bodies[0]!;
}

interface SourceMethod {
  /** Absent in the source means public — which is exactly what "a seam method" means here. */
  isPublic: boolean;
  body: string;
}

/**
 * Every method of a class body, as name → { isPublic, body }, where a body runs to the next method
 * declaration. Deliberately anchored on two-space indentation: a class member is the only thing at
 * that depth, and a shape this cannot read shows up as a missing method rather than as a wrong one —
 * which is why the caller asserts the seam methods it expects to find.
 */
function methodsOf(classBody: string): Map<string, SourceMethod> {
  const starts = [
    ...classBody.matchAll(/^ {2}(?:(private|protected|public) )?(?:async )?(\w+)\s*\(/gm),
  ];
  const out = new Map<string, SourceMethod>();
  starts.forEach((start, i) => {
    const end = i + 1 < starts.length ? starts[i + 1]!.index! : classBody.length;
    out.set(start[2]!, {
      isPublic: start[1] === undefined || start[1] === 'public',
      body: classBody.slice(start.index!, end),
    });
  });
  return out;
}

/**
 * The methods of several classes in ONE table, keyed by name alone — a name declared by two classes
 * keeps both bodies, so a walk over this table over-approximates rather than losing a call site.
 */
function tableOf(bodies: string[]): Map<string, SourceMethod[]> {
  const out = new Map<string, SourceMethod[]>();
  for (const body of bodies) {
    for (const [name, method] of methodsOf(body)) out.set(name, [...(out.get(name) ?? []), method]);
  }
  return out;
}

/** Every method of every class under `src/`, as the walk below needs to see them. */
const methodsInSource = (): Map<string, SourceMethod[]> =>
  tableOf(sourceModules().flatMap(classBodies));

/**
 * The Web API methods reachable from `entry` — its own `this.api('…')` call sites plus everything
 * the `this.<method>(…)` and `this.<field>.<method>(…)` calls in its body reach, transitively.
 * TRANSITIVE is the point: every interesting call site sits behind a private helper (`runFetch`,
 * `openSocket`, `authTest`) and several sit in a class the plugin COMPOSES rather than in the
 * plugin, so a one-level scan — or one that stops at the field holding the collaborator — would say
 * no seam method calls anything at all. The `seen` set makes the mutual recursion in the socket
 * lifecycle (`openSocket` → `reconnect` → `ensureSocket` → `openSocket`) a walk rather than a hang.
 */
function apiMethodsReachedFrom(methods: Map<string, SourceMethod[]>, entry: string): Set<string> {
  const found = new Set<string>();
  const seen = new Set<string>();
  const walk = (name: string): void => {
    if (seen.has(name)) return;
    seen.add(name);
    for (const method of methods.get(name) ?? []) {
      for (const called of methodsCalledIn(method.body)) found.add(called);
      for (const ref of method.body.matchAll(/this\.(?:\w+\.)*(\w+)\s*[(<]/g)) walk(ref[1]!);
    }
  };
  walk(entry);
  return found;
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
    for (const [method, row] of scopeTable()) {
      expect(method).not.toMatch(/\.list$/);
      expect(row.scope).not.toMatch(/channels:read/);
    }
  });

  /**
   * CLASS: a documented table COLUMN that no parity test reads. The two tests above grade columns 1
   * and 2, so the third — the one an operator debugging a `missing_scope` follows to find which seam
   * call needs the grant — was the only one free to be wrong, and it was: `subscribe` probes
   * `conversations.history` and a blocking `fetchRecent` dials `apps.connections.open`, neither of
   * which the cell named. Graded by REACHABILITY rather than by a hand-kept list, so a new call site
   * inside any seam method fails here rather than in an operator's `missing_scope`.
   */
  it("each row's 'Used by' cell is exactly the seam methods whose code path reaches that call", () => {
    const seam = [...methodsOf(seamClassBody())]
      .filter(([, m]) => m.isPublic)
      .map(([name]) => name);
    // The walk found the class, not an empty string that would agree with an empty README.
    expect(seam.sort()).toEqual(
      ['connect', 'disconnect', 'fetchRecent', 'post', 'resolveIdentity', 'subscribe'].sort(),
    );

    const methods = methodsInSource();
    const table = scopeTable();
    expect(table.size).toBeGreaterThan(0);
    for (const [method, row] of table) {
      const reachedBy = seam.filter((entry) => apiMethodsReachedFrom(methods, entry).has(method));
      expect(reachedBy.length, `nothing in the seam reaches ${method}`).toBeGreaterThan(0);
      expect([...row.usedBy].sort(), `README 'Used by' for ${method}`).toEqual([...reachedBy].sort());
    }
  });

  // CLASS: the source-scanning guard again — this walk has four ways to go blind (miss a method,
  // stop following `this.<method>` calls, stop at the field holding a collaborator, or hang on the
  // socket lifecycle's mutual recursion), and all four would leave the parity check above comparing
  // two empty sets.
  it('the reachability walk reads method bodies, follows this.<method> and this.<field>.<method> calls, and survives a cycle', () => {
    const seamLike = [
      '  async alpha(): Promise<void> {',
      '    await this.beta();',
      '  }',
      '',
      '  private async beta(): Promise<void> {',
      "    await this.api<{ ok: boolean }>('deep.method', {});",
      '    void this.alpha();',
      '  }',
      '',
      '  public gamma(): void {',
      "    this.api('shallow.method', {});",
      '  }',
      '',
      '  public delta(): void {',
      '    void this.collaborator.reached();',
      '  }',
      '',
      '  private readonly notAMethod = new Map<string, string>();',
    ].join('\n');
    const collaborator = [
      '  reached(): void {',
      "    this.api('composed.method', {});",
      '  }',
    ].join('\n');

    const methods = methodsOf(seamLike);
    expect([...methods.keys()]).toEqual(['alpha', 'beta', 'gamma', 'delta']);
    expect([...methods].filter(([, m]) => m.isPublic).map(([n]) => n)).toEqual([
      'alpha',
      'gamma',
      'delta',
    ]);

    const table = tableOf([seamLike, collaborator]);
    expect(apiMethodsReachedFrom(table, 'alpha')).toEqual(new Set(['deep.method']));
    expect(apiMethodsReachedFrom(table, 'gamma')).toEqual(new Set(['shallow.method']));
    // The hop the plugin's own layout depends on: a call through a field into another class.
    expect(apiMethodsReachedFrom(table, 'delta')).toEqual(new Set(['composed.method']));
    expect(apiMethodsReachedFrom(table, 'nosuch')).toEqual(new Set());
  });

  // CLASS: an extractor that reads one file where the code now spans several. Both source-driven
  // scans are anchored on `src/` rather than on a path, so a module added later is covered the
  // moment it lands — and a class body it cannot read fails here rather than silently narrowing.
  it('the class-body extractor finds every exported class in a module', () => {
    const module = [
      '',
      'export class One implements BackendPlugin {',
      '  a(): void {}',
      '}',
      '',
      'export class Two {',
      '  b(): void {}',
      '}',
      '',
    ].join('\n');
    expect(classBodies(module)).toEqual(['  a(): void {}', '  b(): void {}']);
    expect([...tableOf(classBodies(module)).keys()]).toEqual(['a', 'b']);
  });
});

/**
 * CLASS: a load-time rule stated in prose. An operator reads the config section to find out which
 * values are refused and which merely warn, and both answers live in the code — a README that
 * quotes a ceiling the validator does not enforce sends them to debug the wrong layer.
 */
describe('slack config docs track what connect() actually enforces', () => {
  const configSection = (): string => {
    const found = /## Config \(`backend_config`\)([\s\S]*?)\n## /.exec(read('../README.md'));
    expect(found, 'README has no Config section').not.toBeNull();
    return found![1]!;
  };

  it('documents every knob the timer ceiling applies to', () => {
    const text = configSection();
    for (const key of TIMER_CONFIG_KEYS) expect(text, `${key} undocumented`).toContain(key);
  });
});

/**
 * The import list is a claim about the module too: it tells a reader which pieces the code below is
 * composed of. `isLoopbackHost` sat in this one telling a reader the plaintext check had two halves
 * when one of them was never called — and it reached the published `dist/` as a real import, because
 * the repo ships no linter and `tsconfig.base.json` enables neither `noUnusedLocals` nor
 * `noUnusedParameters`, so nothing in CI can fail on it. Parameterized over the modules the build
 * compiles, so a module added later — at any depth — is covered the moment it lands.
 */
describe('slack source imports are all used', () => {
  const modules = slackSourceModules().map((m) => [m.name, m.text] as const);

  it('finds source modules to check (guards against a broken walk)', () => {
    expect(modules.length).toBeGreaterThan(1);
  });

  it.each(modules)('%s imports nothing it does not reference', (_name, text) => {
    const imported: string[] = [];
    for (const statement of text.matchAll(/^import\s+([\s\S]*?)\s+from\s+'[^']+';$/gm)) {
      const clause = statement[1] as string;
      const braced = /\{([\s\S]*)\}/.exec(clause)?.[1] ?? '';
      for (const spec of braced.split(',')) {
        const name = /(?:\bas\s+)?(\w+)\s*$/.exec(spec.trim())?.[1];
        if (name !== undefined) imported.push(name);
      }
      const bare = /^(\w+)\s*(?:,|$)/.exec(clause)?.[1];
      if (bare !== undefined) imported.push(bare);
    }
    // Guard the extractor: a pattern that stopped matching would make the check vacuous.
    expect(imported.length).toBeGreaterThan(0);

    const body = text.replace(/^import\s+[\s\S]*?\s+from\s+'[^']+';$/gm, '');
    expect(imported.filter((name) => !new RegExp(`\\b${name}\\b`).test(body))).toEqual([]);
  });
});
