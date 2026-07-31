/**
 * CLASS: prose that restates something the code owns must be checked against the code — EVERY
 * column of it, not the columns that were easy to grade.
 *
 * (1) The documented required scopes must equal the scopes the code actually exercises. A scope in
 *     the provisioning list that no call needs is not free — operators grant it, and it widens what
 *     a leaked `xoxb-` token can do (DESIGN §14). A call whose scope is undocumented is worse: the
 *     bridge fails at runtime with a `missing_scope` nobody can map back. The table's third column
 *     — which seam method sends the call — is graded on the same footing, by reachability.
 *
 * (2) The rate-limit paragraph restates a policy that lives in `@sharptrick/parley-net-util`, which
 *     has already changed under it once — the README kept claiming a server-stated `Retry-After` was
 *     clamped to 5 s long after the helper began honouring it in full. Prose cannot be diffed
 *     against a helper, so the paragraph is required to name each constant it depends on BY VALUE,
 *     imported from the helper: a policy change then fails here instead of misleading an operator.
 */
import {
  DEFAULT_BACKOFF_MS,
  DEFAULT_DEADLINE_MS,
  MAX_BACKOFF_MS,
} from '@sharptrick/parley-net-util';
import {
  DIAL_BACKOFF_MS,
  HISTORY_PAGE_LIMIT,
  MAX_DIAL_BACKOFF_MS,
  MAX_HISTORY_PAGES,
  MAX_TIMER_MS,
  TIMER_CONFIG_KEYS,
} from '../src/index.js';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { MAX_BLOCK_MS } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { rungStarts } from './harness.js';

const read = (rel: string): string =>
  readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

const srcDir = fileURLToPath(new URL('../src', import.meta.url));

/**
 * Every module under `src/`. The plugin composes its Web API calls out of several of them, so keep
 * every scan below reading the TREE rather than one path, so that moving a call site between
 * modules cannot leave a parity check grading an empty set.
 */
function sourceModules(): string[] {
  const files = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));
  expect(files.length, 'no source modules found under src/').toBeGreaterThan(1);
  return files.map((f) => readFileSync(join(srcDir, f), 'utf8'));
}

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

describe('slack rate-limit docs track the shared helper', () => {
  const paragraph = (): string => {
    const readme = read('../README.md');
    const found = /\*\*Rate-limit behaviour\.\*\*([\s\S]*?)\n\n/.exec(readme);
    expect(found, 'README has no **Rate-limit behaviour.** paragraph').not.toBeNull();
    return found![1]!;
  };

  const seconds = (ms: number): string => `${ms / 1000} s`;

  it('names every net-util constant it depends on, by value', () => {
    const text = paragraph();
    for (const [name, ms] of [
      ['MAX_BACKOFF_MS', MAX_BACKOFF_MS],
      ['DEFAULT_DEADLINE_MS', DEFAULT_DEADLINE_MS],
    ] as const) {
      expect(text, `${name} value missing`).toContain(seconds(ms));
      expect(text, `${name} not named`).toContain(name);
    }
    expect(text).toContain('DEFAULT_BACKOFF_MS');
    expect(text).toContain(`${DEFAULT_BACKOFF_MS} ms`);
  });

  it('does not restate the superseded rule that a stated hint is clamped', () => {
    const text = paragraph();
    expect(text).toMatch(/honoured\s+\*\*in full\*\*/);
    expect(text).not.toMatch(/`Retry-After`[\s\S]*honoured up to/);
  });

  // The same paragraph now quotes the degradation ladder, and an operator reads its cost/latency
  // claim off those two figures — so they are pinned by value from the source, like the net-util set.
  it('names the degradation ladder constants it depends on, by value', () => {
    const text = paragraph();
    expect(text, 'DIAL_BACKOFF_MS not named').toContain('DIAL_BACKOFF_MS');
    expect(text, 'DIAL_BACKOFF_MS value missing').toContain(`${DIAL_BACKOFF_MS} ms`);
    expect(text, 'MAX_DIAL_BACKOFF_MS not named').toContain('MAX_DIAL_BACKOFF_MS');
    expect(text, 'MAX_DIAL_BACKOFF_MS value missing').toContain(seconds(MAX_DIAL_BACKOFF_MS));
  });

  // The superseded claim itself: the plugin re-queried history exactly once, at the deadline. An
  // operator reading that sizes `block_max_ms` expecting a minute of latency to be normal.
  it('does not restate the superseded rule that history is re-read only at the end', () => {
    expect(paragraph()).not.toMatch(/re-querying history once at the end|two `conversations\.history`/);
  });

  // The paragraph's COST claim, computed from the ladder rather than characterised. `O(log block_ms)`
  // was true only by coincidence at the default budget: the ladder caps, so the rung count is linear
  // in `block_ms` past the cap, and an operator who raises `block_max_ms` on the strength of a
  // logarithmic bound buys two orders of magnitude more requests than the prose promised.
  it('states a per-call request bound the ladder actually produces', () => {
    const text = paragraph();
    // The rung counts the ladder yields, pinned by value: a reshaped ladder fails HERE first, and
    // then again on the prose below, so the two cannot drift apart.
    expect(rungStarts(4_000).length, 'rungs at 4 s').toBe(5);
    expect(rungStarts(60_000).length, 'rungs at 60 s').toBe(16);
    expect(rungStarts(MAX_BLOCK_MS).length, 'rungs at the core ceiling').toBe(64);
    // Linear past the cap is the property the superseded claim got wrong; state it, and the two
    // figures an operator sizes `block_max_ms` from.
    expect(text, 'still claims a logarithmic bound').not.toMatch(/O\(log/);
    expect(text).toContain('4 + block_ms / MAX_DIAL_BACKOFF_MS');
    // The claim is only true because each rung resumes where the last read stopped; when it did
    // not, the real figure was that bound MULTIPLIED by the pages above the caller's cursor.
    const prose = text.replace(/\s+/g, ' ');
    expect(prose, 'the per-rung resume is not stated').toMatch(
      /Each rung resumes from the position the previous read walked to/,
    );
    expect(prose).toMatch(/\*\*once\*\* rather than once per rung/);
    expect(text).toContain(`${rungStarts(60_000).length} reads and dials`);
    expect(text).toContain(`~${rungStarts(MAX_BLOCK_MS).length} of each`);
    expect(text).toMatch(/\*\*linear\*\*, not logarithmic/);
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

  it('names the timer ceiling by value and every knob it applies to', () => {
    const text = configSection();
    expect(text, 'timer ceiling value missing').toContain(String(MAX_TIMER_MS));
    for (const key of TIMER_CONFIG_KEYS) expect(text, `${key} undocumented`).toContain(key);
  });

  it('states that a plaintext remote api_url warns rather than fails, and what it leaks', () => {
    const text = configSection();
    expect(text).toMatch(/api_url/);
    expect(text).toMatch(/warns/);
    expect(text).toMatch(/loopback/);
    expect(text).toMatch(/in the clear/);
  });
});

/**
 * CLASS: a README consequence about CORE behaviour, asserted against core rather than narrated.
 *
 * The "give every session its own bot" warning used to justify itself with a roster collapse —
 * "their presence heartbeats all arrive as the same `senderHandle`, the roster collapses them into
 * one phantom peer … and hand-off by handle then targets the wrong instance". Core stopped working
 * that way: `computeRoster` keys on the presence RECORD's self-reported `handle` and scopes liveness
 * per per-process `instanceId`, precisely so bot-token backends do not collapse. The prose outlived
 * the mechanism, and an operator reading it provisions a second Slack app to avoid a failure that
 * does not occur. `computeRoster` is not exported from `@sharptrick/parley-core`, so the mechanism is
 * pinned from its source: if core goes back to keying on `senderHandle`, this fails and the README
 * has to move with it.
 */
describe('slack multi-session docs track the roster mechanism in core', () => {
  const presenceSource = (): string => read('../../bridge-core/src/engine/presence.ts');

  const emitterOfBody = (): string => {
    const found = /function emitterOf\([^)]*\): Handle \{([\s\S]*?)\n\}/.exec(presenceSource());
    expect(found, 'bridge-core presence.ts has no emitterOf(rec, m) function').not.toBeNull();
    return found![1]!;
  };

  it('core keys the roster on the record handle, with senderHandle only as the fallback', () => {
    const body = emitterOfBody();
    // The record's handle leads; `senderHandle` may appear only as the undefined-fallback arm.
    expect(body).toMatch(/rec\.handle === undefined \?[\s\S]*m\.senderHandle[\s\S]*rec\.handle/);
    expect(presenceSource(), 'liveness is scoped per instance').toContain('rec.instanceId');
  });

  /** The section with its line wrapping collapsed, so a claim is matched as prose, not as layout. */
  const multiSession = (): string => {
    const readme = read('../README.md');
    const found = /## Multiple concurrent sessions[\s\S]*?\n## /.exec(readme);
    expect(found, 'README has no Multiple concurrent sessions section').not.toBeNull();
    return found![0]!.replace(/\s+/g, ' ');
  };

  it('does not restate the superseded roster-collapse consequence', () => {
    const text = multiSession();
    for (const claim of [/roster collapses/i, /phantom peer/i, /targets the wrong instance/i]) {
      expect(text, `superseded claim still present: ${String(claim)}`).not.toMatch(claim);
    }
  });

  // The vendor rule the section's advice rests on: Socket Mode routes each payload to ONE of an
  // app's open connections. The README used to claim the opposite ("every open socket receives every
  // subscribed event"), which turns "at least its own bot user" into advice that silently drops half
  // of each session's live pushes. `multi-session-push.test.ts` grades the behaviour; this keeps the
  // prose from drifting back.
  it('does not restate the superseded claim that every open socket receives every event', () => {
    const text = multiSession();
    expect(text).not.toMatch(/every open socket receives/i);
    expect(text).toMatch(/exactly one\*\* of an app's open connections/);
    expect(text).toMatch(/own Slack app/i);
  });

  it('states the consequences that do survive, and that the roster is not one of them', () => {
    const text = multiSession();
    // Attribution in agent context, which the conformance identity case pins executably…
    expect(text).toMatch(/senderHandle/);
    expect(text).toMatch(/one bot id/i);
    // …the Socket Mode connection quota…
    expect(text).toMatch(/~10 concurrent connections per app token/);
    // …and an explicit statement that `parley_list_users` is unaffected, so the corrected claim is
    // itself pinned rather than merely absent.
    expect(text).toMatch(/`parley_list_users` is \*\*not\*\* affected/);
  });
});

/**
 * CLASS: prose that quotes a number the source owns. The catch-up cost model is stated as a formula
 * over the page size and the walk's page ceiling, and an operator sizes `catchup.limit` from it — so
 * a change to either constant that leaves the paragraph behind is a wrong recommendation, not a typo.
 */
describe('slack catch-up docs track the figures the source sends', () => {
  const readme = (): string => read('../README.md');

  it('the stated page figure is the `limit` the source actually asks for', () => {
    expect(readme()).toContain(`page = ${HISTORY_PAGE_LIMIT}`);
  });

  it('the walk ceiling and the operator recovery step are both documented', () => {
    const text = readme();
    expect(text).toContain(String(MAX_HISTORY_PAGES));
    // A cap the cursor cannot advance past repeats on every catch-up, so the way out has to be in
    // the README rather than in the reader's head.
    expect(text).toMatch(/reset .*cursor|cursor .*reset/i);
  });

  it('states the tier that decides whether the page figure is honoured at all', () => {
    // Both figures by value and both sides of the split: an operator cannot size `catchup.limit`
    // from the cost model without knowing which allowance their app is on.
    const text = readme();
    expect(text).toMatch(/Marketplace/);
    expect(text).toMatch(/15 objects per request/);
    expect(text).toMatch(/one request per\s+minute/);
    expect(text).toMatch(/internal,? customer-built app/i);
  });
});

/**
 * The import list is a claim about the module too: it tells a reader which pieces the code below is
 * composed of. `isLoopbackHost` sat in this one telling a reader the plaintext check had two halves
 * when one of them was never called — and it reached the published `dist/` as a real import, because
 * the repo ships no linter and `tsconfig.base.json` enables neither `noUnusedLocals` nor
 * `noUnusedParameters`, so nothing in CI can fail on it. Parameterized over `src/`, so a module
 * added later is covered the moment it lands.
 */
describe('slack source imports are all used', () => {
  const srcDir = fileURLToPath(new URL('../src', import.meta.url));
  const modules = readdirSync(srcDir).filter((f) => f.endsWith('.ts'));

  it('finds source modules to check (guards against a broken walk)', () => {
    expect(modules.length).toBeGreaterThan(1);
  });

  it.each(modules)('%s imports nothing it does not reference', (file) => {
    const text = readFileSync(join(srcDir, file), 'utf8');
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
