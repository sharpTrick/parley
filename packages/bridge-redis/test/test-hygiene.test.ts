import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Rules about this package's own test files, guarded by construction rather than per row, so a future
// case cannot re-introduce either defect by being new.

const HERE = new URL('.', import.meta.url);

/** `support.ts` owns every endpoint this package's tests connect to; every other file goes through it. */
const OWNS_ENDPOINTS = 'support.ts';

const files = readdirSync(HERE)
  .filter((f) => /\.ts$/.test(f) && f !== OWNS_ENDPOINTS)
  .sort();

const sourceOf = (file: string): string => readFileSync(new URL(file, HERE), 'utf8');

// CLASS: a case that connects to (or asserts nothing is listening on) a port it does not own. A row
// naming a fixed loopback port fails the moment any other process on the box takes it — a sibling
// agent's throwaway server, a leftover container — and it fails for a reason that has nothing to do
// with the code. The fix is not to pick a quieter number: it is to mint the port, which `support.ts`
// does (`freeEndpoint`), or to take the endpoint under test from `REDIS_URL`.

/**
 * A connection URL naming a loopback port as a literal. Deliberately narrow to the `redis://` form
 * with a whole port: a minted `redis://127.0.0.1:${port}` is not a match, and neither is a RESP
 * payload (`MOVED 3999 127.0.0.1:6381`) or a malformed-URL row that exists to be REJECTED.
 */
const BORROWED_ENDPOINT = /rediss?:\/\/(?:[^\s'"`@]*@)?(?:127\.0\.0\.1|localhost|\[::1]):\d+/g;

describe('bridge-redis tests — no case connects to a loopback endpoint of its own', () => {
  it('has files to check, so the rows below are not vacuous', () => {
    expect(files.length).toBeGreaterThan(1);
  });

  it.each(files)('%s borrows no loopback port', (file) => {
    const found = [...sourceOf(file).matchAll(BORROWED_ENDPOINT)].map((m) => m[0]);
    expect(
      found,
      `${file} names ${found.join(', ')} directly; take the endpoint from ${OWNS_ENDPOINTS} ` +
        `(freeEndpoint / REDIS_URL) so the test owns the guarantee it asserts`,
    ).toEqual([]);
  });

  // The inverse arm: the pattern must actually match the shape it exists to ban, or every row above
  // is green because the regex is broken rather than because the files are clean. Assembled from
  // parts, so this file stays subject to its own rule instead of exempting itself from it.
  const loopback = ['127.0.0.1', 'localhost', '[::1]'];
  const banned = [
    ...loopback.map((host) => `redis://${host}:6399`),
    ...loopback.map((host) => `rediss://${host}:6379`),
    `redis://:hunter2@${loopback[0]}:6399`,
  ];

  it.each(banned)('the rule recognises %s as a borrowed endpoint', (url) => {
    expect(url).toMatch(new RegExp(BORROWED_ENDPOINT.source));
  });

  const allowed = [
    'redis://127.0.0.1:${port}', // a minted port, which is the whole point
    'MOVED 3999 127.0.0.1:6381', // a RESP payload, not a connection target
    'http://127.0.0.1:6379', // a malformed-url row that exists to be REJECTED
    'redis://parley-no-such-host.invalid:6379', // deliberately unresolvable, owned by nobody
  ];

  it.each(allowed)('the rule does not fire on %s', (text) => {
    expect(text).not.toMatch(new RegExp(BORROWED_ENDPOINT.source));
  });
});

// CLASS: a file that mixes server-gated blocks with ungated ones. CI's skip gate fails only files
// where EVERY assertion skipped, so a mixed file reports a clean pass with its gated half silently
// deleted — a Redis that failed to come up removes that coverage and the build stays green. Keeping
// the two kinds in separate files is what makes a missing server visible, and only a rule can keep
// them separate: adding one ungated case to a gated file re-opens the hole with nothing red.

/** A block that self-skips when the server is away. */
const GATED_BLOCK = /describe\.skipIf\(/;

/** A top-level block that runs unconditionally — column 0, so a block nested inside a gate is not one. */
const UNGATED_BLOCK = /^describe(?:\.each)?\(/m;

describe('bridge-redis tests — a server-gated file has no ungated cases', () => {
  const gated = files.filter((file) => GATED_BLOCK.test(sourceOf(file)));

  it('some file is server-gated, so the rows below are not vacuous', () => {
    expect(gated).not.toEqual([]);
  });

  it.each(gated)('%s is gated all the way through', (file) => {
    const ungated = UNGATED_BLOCK.exec(sourceOf(file));
    expect(
      ungated?.[0],
      `${file} gates some blocks and runs others unconditionally, so a missing server makes it ` +
        `pass with half its cases skipped instead of skipping outright — move the ungated blocks ` +
        `into a file of their own`,
    ).toBeUndefined();
  });

  // Both rules must recognise the shapes they exist to sort, or every row above is green because a
  // regex is broken rather than because the files are clean. `describe` is spelled through a variable
  // so these samples are not themselves collected as blocks.
  const d = 'describe';
  it.each([
    [`${d}.skipIf(!redisUp)('x', () => {})`, true, false],
    [`${d}('x', () => {})`, false, true],
    [`${d}.each([1])('x', () => {})`, false, true],
    [`  ${d}('nested inside a gate', () => {})`, false, false],
    [`${d}.skip('explicitly skipped', () => {})`, false, false],
  ])('the rules read %s as gated=%s, ungated=%s', (sample, isGated, isUngated) => {
    expect(GATED_BLOCK.test(sample)).toBe(isGated);
    expect(UNGATED_BLOCK.test(sample)).toBe(isUngated);
  });
});
