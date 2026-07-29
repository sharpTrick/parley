import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CONTEXT_FIELDS } from '@sharptrick/parley-conformance';

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8');

/** Every `it(...)` body in the suite, split on the top-level case boundary. */
function cases(): { title: string; body: string }[] {
  const out: { title: string; body: string }[] = [];
  const starts = [...source.matchAll(/^ {4}it(?:\.each\([\s\S]*?\))?\(\s*$|^ {4}it(?:\.each\(.*\))?\(/gm)];
  for (const [i, m] of starts.entries()) {
    const from = m.index;
    const to = i + 1 < starts.length ? starts[i + 1]!.index : source.length;
    const body = source.slice(from, to);
    out.push({ title: /'([^']+)'/.exec(body)?.[1] ?? `case ${i}`, body });
  }
  return out;
}

describe('the suite grades every backend it certifies', () => {
  // Without this the checks below read an empty list and pass having examined nothing.
  it('parses the suite into its cases', () => {
    expect(cases().length).toBeGreaterThan(10);
    expect(cases().map((c) => c.title)).toContain('topics are isolated');
  });

  // A capability flag whose false branch is a SKIP trades coverage for a boolean: the backend that
  // declares it loses the only cases that would have caught the behaviour. The only legitimate skip
  // is a capability the backend cannot represent AT ALL, which the context states as 'unsupported'.
  it('never skips a case on a self-declared capability flag', () => {
    const skipping = cases().filter((c) => c.body.includes('testCtx.skip()'));
    expect(skipping).toHaveLength(1); // exactly the 'unsupported' one, and no other
    const unjustified = skipping.filter((c) => !c.body.includes("=== 'unsupported'"));
    expect(unjustified.map((c) => c.title)).toEqual([]);
  });

  // A required context field nobody reads is a field a fixture author must supply for nothing —
  // and, worse, looks like coverage.
  it.each(Object.keys(CONTEXT_FIELDS))('reads the required field `%s`', (field) => {
    expect(source).toContain(`ctx.${field}`);
  });

  // Both arms of each boolean capability must ASSERT. Pinned by name so that deleting the weaker
  // arm — the thing that made the flag honest — is a failure, not a silent loss.
  it.each([
    ['supportsBlockingFetch', 'blockMs is honoured natively or ignored promptly'],
    ['carriesSenderIdentity', 'distinct senders are not collapsed'],
  ])('gives `%s` a false arm that still asserts', (field, title) => {
    const owner = cases().find((c) => c.title.includes(title));
    expect(owner, `no case titled like "${title}"`).toBeDefined();
    const body = (owner as { body: string }).body;
    expect(body).toContain(`ctx.${field}`);
    expect(body).toMatch(/\}\s*else\s*\{|if \(!ctx\./);
    const arms = body.split(/\}\s*else\s*\{|if \(!ctx\./);
    for (const arm of arms.slice(1)) expect(arm).toContain('expect(');
  });
});
