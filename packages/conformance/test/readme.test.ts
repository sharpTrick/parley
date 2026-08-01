import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  type BackendFactory,
  CLAUSES,
  type ConformanceContext,
  CONTEXT_FIELDS,
  openContext,
} from '@sharptrick/parley-conformance';

const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');
const packagesDir = new URL('../../', import.meta.url);

/** Workspace packages whose package.json depends on this one — the suite's real consumer set. */
function consumers(): string[] {
  const out: string[] = [];
  for (const dir of readdirSync(packagesDir)) {
    let pkg: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
    try {
      pkg = JSON.parse(
        readFileSync(new URL(`${dir}/package.json`, packagesDir), 'utf8'),
      ) as typeof pkg;
    } catch {
      continue;
    }
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    if ('@sharptrick/parley-conformance' in deps && pkg.name !== undefined) out.push(dir);
  }
  return out.sort();
}

// The README restates the ConformanceContext type and lists the backends it runs against; both
// drifted far enough that its `makeContext()` example no longer compiled against the real type.
/**
 * The fenced `ts` block that restates `ConformanceContext`. Scoped to the block, so that a field
 * named only in surrounding prose does not count as documentation: `toContain('plugin')` over the
 * whole file was satisfied by the intro sentence "run it against every backend plugin", so the
 * declaration — or the entire block — could go with the row still green.
 */
function contextBlock(): string {
  const fences = [...readme.matchAll(/```ts\n([\s\S]*?)```/g)].map((m) => m[1] as string);
  return fences.find((f) => f.includes('interface ConformanceContext')) ?? '';
}

describe('README', () => {
  it('has a ConformanceContext code block to scope the field checks to', () => {
    expect(contextBlock()).toContain('interface ConformanceContext');
    expect(contextBlock().length).toBeGreaterThan(200);
  });

  it.each(Object.keys(CONTEXT_FIELDS))('documents the required field `%s`', (field) => {
    expect(contextBlock()).toMatch(new RegExp(`^\\s*${field}\\??:|^\\s*${field}\\(`, 'm'));
  });

  // The README advertises what the suite checks, and a reader has no way to tell whether it still
  // does. Every clause the suite grades must be named here, in the same words the table uses.
  it.each(CLAUSES.map((c) => [c]))('advertises the clause %s', (clause) => {
    expect(readme).toContain(clause);
  });

  /**
   * The other direction, which is the one that decays silently. A clause could be RETIRED — case,
   * `CLAUSES` row and `BROKEN_VARIANTS` entry removed together, every check here still green — with
   * the README still advertising to npm consumers a guarantee eleven certified backends are no
   * longer graded on. That is precisely what the `CLAUSES` table was introduced to prevent, run only
   * one way.
   *
   * Not asserted as set EQUALITY: a bullet legitimately carries more than one clause ("catch-up
   * since a cursor … and since at the tail …"), so equality would force the prose to be one bullet
   * per clause. What holds is that every bullet is claimed by something.
   */
  describe('the clause list advertises nothing the suite has stopped grading', () => {
    /** Bullets that state something the suite is bound to — anything else is recorded below. */
    const NOT_A_CLAUSE: Record<string, string> = {
      'every delivered `Message` is well-formed':
        'an assertion made INSIDE several clauses (expectWellFormedMessage), not a case of its own',
      'a backend that declares `carriesSenderIdentity: false`':
        'the weaker arm of the "not collapsed onto one another" clause, not a separate case',
    };

    const clauseBullets = (): string[] => {
      const from = readme.indexOf('checks the clauses below');
      expect(from, 'the README no longer introduces a clause list').toBeGreaterThan(0);
      return readme
        .slice(from, readme.indexOf('\n## ', from))
        .split(/\n(?=- )/)
        .slice(1)
        .map((bullet) => bullet.trim());
    };

    const claimed = (bullet: string): boolean =>
      CLAUSES.some((clause) => bullet.includes(clause)) ||
      Object.keys(NOT_A_CLAUSE).some((detail) => bullet.includes(detail));

    it('finds the clause list, so the rows below are not reading an empty block', () => {
      expect(clauseBullets().length).toBeGreaterThan(15);
    });

    it.each(clauseBullets().map((bullet) => [`${bullet.slice(2, 60)}…`, bullet] as const))(
      'the bullet "%s" is still a clause the suite grades',
      (_label, bullet) => {
        expect(
          claimed(bullet),
          'this bullet names no entry in CLAUSES — either the clause was retired and the bullet ' +
            'must go with it, or the bullet describes an assertion inside a clause and belongs in ' +
            'NOT_A_CLAUSE with the reason',
        ).toBe(true);
      },
    );

    it('records no detail bullet that has since been rewritten away', () => {
      const stale = Object.keys(NOT_A_CLAUSE).filter(
        (detail) => !clauseBullets().some((bullet) => bullet.includes(detail)),
      );
      expect(stale, 'NOT_A_CLAUSE names a bullet the README no longer has').toEqual([]);
    });
  });

  it("documents the 'unsupported' sentinel rather than an optional concurrentPost", () => {
    expect(readme).toContain("'unsupported'");
    expect(readme).not.toMatch(/concurrentPost\?/);
    expect(readme).not.toMatch(/concurrentPost is optional/);
  });

  it('runs its example command against every package that depends on the suite', () => {
    const missing = consumers().filter((dir) => !readme.includes(`packages/${dir}`));
    expect(missing).toEqual([]);
  });

  /**
   * The README justified the runtime validator by a fact about the repo three times running, and each
   * spelling pinned an ABSOLUTE that decayed as the repo improved: "no tsconfig covers test/**" (false
   * the day this package got one), "no backend typechecks its own test sources" (false the day a
   * backend added a `tsconfig.test.json`), then "at least one consumer's fixture is never seen by a
   * compiler" (false the day every workspace's fixtures came inside one — and every step of that
   * found real type errors). A deficiency is the wrong thing to hold invariant, and the third attempt
   * proved that holding a SHRINKING deficiency invariant is the same mistake at one remove.
   *
   * What keeps the validator necessary is a property of the PUBLISHED surface, which no amount of
   * typechecking in this repo can retire: the fixture crosses a package boundary as a value, so the
   * compiler that would have caught a missing field is on the consumer's side of it — or absent.
   * That is what the rows below assert, and it cannot decay.
   */
  describe('the claim behind the runtime context validator', () => {
    const workspaceDirs = (): string[] =>
      readdirSync(packagesDir).filter((dir) => {
        try {
          readFileSync(new URL(`${dir}/package.json`, packagesDir), 'utf8');
          return true;
        } catch {
          return false;
        }
      });

    it('is not vacuous: this package has suite consumers at all', () => {
      expect(consumers().length).toBeGreaterThan(5);
    });

    /**
     * What keeps the validator necessary, graded through the PUBLISHED surface rather than off the
     * repo's tsconfig coverage: `openContext` takes the factory's result as a value, not as the type
     * the factory declares. A well-typed factory whose context is assembled at runtime — from config,
     * through a cast, or in a JavaScript consumer with no compiler at all — reaches the suite exactly
     * like this one, and the compiler that would have caught the missing field is on the other side
     * of a package boundary.
     */
    it('the validator is load-bearing: a well-typed factory can still deliver a bad context', async () => {
      let tornDown = false;
      const factory: BackendFactory = () =>
        Promise.resolve({
          plugin: {},
          freshTopic: () => 't',
          cleanup: () => {
            tornDown = true;
            return Promise.resolve();
          },
          concurrentPost: 'unsupported',
          carriesSenderIdentity: true,
        } as unknown as ConformanceContext);

      await expect(openContext('a runtime-built context', factory)).rejects.toThrow(
        /has an invalid `supportsBlockingFetch`/,
      );
      expect(tornDown, 'a rejected fixture must still be torn down').toBe(true);
    });

    /**
     * The paragraph that carries the justification. The set it describes changes as packages adopt
     * `tsconfig.test.json`, so it must state the REASON and name no member: a list here goes stale
     * silently, which is how both earlier spellings of this claim became false.
     */
    const validatorParagraph = (): string => {
      const paragraphs = readme.split(/\n\s*\n/).filter((p) => p.includes('assertConformanceContext'));
      expect(paragraphs, 'the README no longer justifies the runtime validator anywhere').toHaveLength(1);
      return paragraphs[0] as string;
    };

    it('states the reason without naming which packages typecheck their tests', () => {
      expect(workspaceDirs().filter((dir) => validatorParagraph().includes(dir))).toEqual([]);
    });

    // Whitespace-insensitive: the claim is prose, so a line wrap must not let it back in.
    it.each([
      ['no tsconfig in the repo covers test/**', /no\s+tsconfig[^.]*includes?\s+`?test/i],
      ['no backend typechecks its own test sources', /\bno\s+backend[^.]*typecheck/i],
      ['only two named packages have a test tsconfig', /only\s+this\s+package\s+and/i],
      // Retired the day every workspace's fixtures came inside a tsconfig: a justification that
      // rests on a deficiency stops being true the moment the deficiency is fixed.
      ['a fixture is never seen by a compiler', /never\s+has\s+its\s+fixture\s+seen/i],
      ['some package still lacks a tsconfig.test.json', /with\s+no\s+`?tsconfig\.test\.json`?/i],
    ])('does not restate the decayed absolute "%s"', (_label, shape) => {
      expect(readme.replaceAll(/\s+/g, ' ')).not.toMatch(shape);
    });
  });
});
