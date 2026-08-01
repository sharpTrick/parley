import { readdirSync, readFileSync } from 'node:fs';

/**
 * The repo scan two checks in this package share. Both of them ask a question about a PACKAGE — does
 * anything re-implement an export of this one, does anything import a given export — and both were
 * answering it from a NON-recursive `readdirSync`, so a file one directory deeper was invisible in
 * both directions: a forked security predicate went unrecorded, and a live import read as dead.
 *
 * Keep the listing recursive and the root a PARAMETER, so that the recursion is gradable against a
 * synthetic tree instead of against whatever shape `packages/` happens to have today.
 */

const HERE = new URL('../', import.meta.url);

export const PACKAGES = new URL('../', HERE);

export const SELF_DIR = HERE.pathname.replace(/\/$/, '').split('/').at(-1) as string;

export const SELF = (
  JSON.parse(readFileSync(new URL('package.json', HERE), 'utf8')) as { name: string }
).name;

export interface SourceFile {
  pkg: string;
  path: string;
  text: string;
  /** Comments stripped, so that a name mentioned only in prose does not read as code. */
  code: string;
}

const stripComments = (text: string): string =>
  text.replaceAll(/\/\*[\s\S]*?\*\//g, '').replaceAll(/^\s*\/\/.*$/gm, '');

export function packageSources(
  subdirs: string[],
  root: URL = PACKAGES,
  selfDir: string = SELF_DIR,
): SourceFile[] {
  const out: SourceFile[] = [];
  for (const pkg of readdirSync(root)) {
    if (pkg === selfDir) continue;
    for (const sub of subdirs) {
      let names: string[] = [];
      try {
        names = readdirSync(new URL(`${pkg}/${sub}/`, root), { recursive: true }).map(String);
      } catch {
        continue;
      }
      for (const name of names.filter((n) => n.endsWith('.ts'))) {
        const path = `${pkg}/${sub}/${name}`;
        const text = readFileSync(new URL(path, root), 'utf8');
        out.push({ pkg, path, text, code: stripComments(text) });
      }
    }
  }
  return out;
}

/**
 * Whether a file loads this package as a MODULE — `from '…'`, `import('…')`, `vi.mock('…')` — rather
 * than merely spelling its name. Keep the module position required, so that a package listing this
 * one in a table of names it must NOT depend on is not read as a consumer of it: `bridge-core`
 * names it in a licence-gap list and imports it nowhere, and counting that made a same-named local
 * helper of core's read as a fork of an export it is forbidden to import.
 */
const namesModule = (code: string): boolean =>
  new RegExp(`(?:\\bfrom\\s*|\\(\\s*)['"]${SELF}['"]`).test(code);

/**
 * Every `src/` file of every package that imports this one. The whole package, not only the files
 * that name the import: a fork is a debt the PACKAGE owes, and splitting one file into several moves
 * the copy away from the import without retiring anything.
 */
export function consumerPackageSources(
  root: URL = PACKAGES,
  selfDir: string = SELF_DIR,
): SourceFile[] {
  const sources = packageSources(['src'], root, selfDir);
  const consuming = new Set(sources.filter(({ code }) => namesModule(code)).map(({ pkg }) => pkg));
  return sources.filter(({ pkg }) => consuming.has(pkg));
}

/** Every `src/` or `test/` file that loads this package, wherever it is nested. */
export function importingFiles(root: URL = PACKAGES, selfDir: string = SELF_DIR): SourceFile[] {
  return packageSources(['src', 'test'], root, selfDir).filter(({ code }) => namesModule(code));
}
