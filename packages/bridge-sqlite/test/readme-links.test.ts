import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const README = readFileSync(fileURLToPath(new URL('../README.md', import.meta.url)), 'utf8');

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
