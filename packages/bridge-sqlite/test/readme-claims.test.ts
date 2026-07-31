import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

/**
 * Every promise this package's README makes, in one table. Filed under the behaviour they happen to
 * sit next to, prose assertions report a documentation failure under a subject it has nothing to do
 * with — a renamed heading surfacing as a cross-process regression — and the doc contract cannot be
 * reviewed in one place. Adding a documented promise is a row here.
 *
 * A row carries the claim, the patterns that must appear, and — where the README sends a reader to a
 * particular test file — the evidence that file has to hold for the pointer to be honest.
 */

const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');
const FLAT = README.replace(/\s+/g, ' ');

interface Claim {
  what: string;
  patterns: RegExp[];
  evidence?: { file: string; pattern: RegExp };
}

/**
 * Every pragma the driver sets buys a property and costs one. A pragma listed under "cross-process
 * safety" whose cost goes unstated reads as free — `synchronous = NORMAL` is the live example: a
 * committed post can be lost on power loss, in the store DESIGN calls the durable source of truth.
 *
 * The retention rows are the other side of that: which rows a prune deletes is a LOSS MODEL, and
 * stated in terms of reader downtime alone it reads as "offline less than the window ⇒ nothing
 * lost", which is false the moment two hosts' clocks disagree.
 *
 * A sentence naming a test file is an instruction to go read that file. Naming the wrong one
 * certifies a property against a file that does not grade it, and keeps reading true after the file
 * that does is deleted — so each attributed claim is pinned to the file holding its evidence, and to
 * no other named file.
 */
const CLAIMS: Claim[] = [
  { what: 'journal_mode with its consequence', patterns: [/journal_mode/, /readers never block the writer/i] },
  { what: 'busy_timeout with its consequence', patterns: [/busy_timeout/, /retries instead of erroring/i] },
  { what: 'synchronous with its consequence', patterns: [/synchronous/, /lost on power loss/i] },
  { what: 'that the retention cutoff is judged against the poster’s clock', patterns: [/poster'?’?s wall clock/i] },
  { what: 'that clock skew between hosts shifts which rows survive', patterns: [/clock skew/i] },
  { what: 'that a row can go before a reader’s cursor reaches it', patterns: [/reader'?’?s cursor has reached it/i] },
  { what: 'that a lock-classed poll failure is quiet but still counted', patterns: [/without a stderr line/i, /every failing tick raises `consecutiveFailures`/i] },
  { what: 'that --help and --version answer on stdout', patterns: [/`--help`\/`--version` answer on \*\*stdout\*\*/] },
  {
    what: 'the pragma read-back',
    patterns: [/read-back|read back/i],
    evidence: { file: 'test/driver-parity.test.ts', pattern: /PRAGMA \$\{p\.name\}/ },
  },
  {
    what: 'the -wal sidecar appearing on disk',
    patterns: [/-wal.{0,3} sidecar/i],
    evidence: { file: 'test/multi-process.test.ts', pattern: /\$\{path\}-wal/ },
  },
];

const NAMED = [...new Set(CLAIMS.flatMap((c) => (c.evidence === undefined ? [] : [c.evidence.file])))];
const sentencesNaming = (file: string): string[] =>
  FLAT.split(/(?<=\.)\s/).filter((s) => s.includes(file));

describe('the README states what this package promises', () => {
  for (const c of CLAIMS.filter((claim) => claim.evidence === undefined)) {
    it(`it states ${c.what}`, () => {
      for (const p of c.patterns) expect(FLAT).toMatch(p);
    });
  }
});

describe('the README credits each claim to the file that grades it', () => {
  for (const c of CLAIMS) {
    const evidence = c.evidence;
    if (evidence === undefined) continue;
    it(`${c.what} is credited to ${evidence.file}, and that file holds the evidence`, () => {
      const own = sentencesNaming(evidence.file);
      expect(own.length).toBeGreaterThan(0);
      for (const p of c.patterns) {
        expect(own.filter((s) => p.test(s)).length).toBeGreaterThan(0);
        for (const other of NAMED.filter((f) => f !== evidence.file)) {
          expect(sentencesNaming(other).filter((s) => p.test(s))).toEqual([]);
        }
      }
      expect(
        readFileSync(fileURLToPath(new URL(`../${evidence.file}`, import.meta.url)), 'utf8'),
      ).toMatch(evidence.pattern);
    });
  }
});

/**
 * A relative link carrying an `#anchor` is a claim about ANOTHER file's headings, and nothing
 * re-checks it when that file is edited. GitHub and npm render a missing anchor as the top of the
 * target document, so the reader lands hundreds of lines from the section they were sent to, with no
 * error anywhere — which is how this package's one "wire it into Claude Code" pointer came to name a
 * heading the root README had renamed.
 */
describe('every README link resolves, anchor included', () => {
  const LINKS = [...README.matchAll(/\]\((\.[^)\s]+)\)/g)].map((m) => m[1] as string);
  /** GitHub's heading slug: lowercased, punctuation dropped, spaces hyphenated. */
  const slug = (heading: string): string =>
    heading
      .toLowerCase()
      .replace(/[^\w\- ]+/g, '')
      .trim()
      .replace(/ +/g, '-');
  const headingsOf = (markdown: string): string[] =>
    [...markdown.replace(/^```[\s\S]*?^```/gm, '').matchAll(/^#{1,6} +(.+?)\s*$/gm)].map((m) =>
      slug(m[1] as string),
    );

  it('the README carries relative links to grade', () => {
    expect(LINKS.filter((l) => l.includes('#')).length).toBeGreaterThan(0);
  });

  for (const link of LINKS) {
    it(`${link} resolves`, () => {
      const [rel, anchor] = link.split('#');
      const target = fileURLToPath(new URL(`../${rel as string}`, import.meta.url));
      expect(existsSync(target), `${target} does not exist`).toBe(true);
      if (anchor === undefined) return;
      expect(headingsOf(readFileSync(target, 'utf8'))).toContain(anchor);
    });
  }
});
