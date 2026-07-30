/**
 * CLASS: prose that restates something the code owns must be checked against the code.
 *
 * (1) The documented required scopes must equal the scopes the code actually exercises. A scope in
 *     the provisioning list that no call needs is not free — operators grant it, and it widens what
 *     a leaked `xoxb-` token can do (DESIGN §14). A call whose scope is undocumented is worse: the
 *     bridge fails at runtime with a `missing_scope` nobody can map back.
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
} from '../src/index.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { MAX_BLOCK_MS } from '@sharptrick/parley-core';
import { describe, expect, it } from 'vitest';
import { rungStarts } from './harness.js';

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
    expect(text).toContain(`${rungStarts(60_000).length} reads and dials`);
    expect(text).toContain(`~${rungStarts(MAX_BLOCK_MS).length} of each`);
    expect(text).toMatch(/\*\*linear\*\*, not logarithmic/);
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
