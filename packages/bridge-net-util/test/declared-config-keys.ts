import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

/**
 * Every backend's OWN declaration of what its `backend_config` holds, read from the
 * `satisfies Record<keyof Required<…>, …>` block each plugin already writes to make an undeclared
 * key a compile error. Derived from the source rather than from a list a fix round happens to
 * update, so that a plugin — or a key — added later is graded by existing rather than by being
 * remembered: this chunk shipped the same renderer leak three times behind a hand-listed set.
 */
export interface BackendConfigDeclaration {
  /** Directory name under `packages/`. */
  pkg: string;
  /** Every declared key, nested members (`tls.ca_file` → `ca_file`) included. */
  keys: readonly string[];
}

const PACKAGES = fileURLToPath(new URL('../../', import.meta.url));

const entries = (dir: string): { name: string; dir: boolean }[] => {
  try {
    return readdirSync(dir, { withFileTypes: true }).map((e) => ({
      name: e.name,
      dir: e.isDirectory(),
    }));
  } catch {
    return [];
  }
};

function filesUnder(dir: string, keep: (name: string) => boolean, out: string[] = []): string[] {
  for (const entry of entries(dir)) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const path = join(dir, entry.name);
    if (entry.dir) filesUnder(path, keep, out);
    else if (keep(entry.name)) out.push(path);
  }
  return out;
}

const isSource = (name: string): boolean => name.endsWith('.ts') && !name.endsWith('.test.ts');
const isTest = (name: string): boolean => name.endsWith('.test.ts');

/** The property names of every `… satisfies Record<keyof Required<X>, …>` object in one source. */
export function declaredKeysIn(source: string): string[] {
  const parsed = ts.createSourceFile('config.ts', source, ts.ScriptTarget.ESNext, true);
  const keys: string[] = [];
  const visit = (node: ts.Node): void => {
    if (
      ts.isSatisfiesExpression(node) &&
      /keyof\s+Required</.test(node.type.getText(parsed)) &&
      ts.isObjectLiteralExpression(node.expression)
    ) {
      for (const prop of node.expression.properties) {
        const name = prop.name;
        if (name !== undefined && (ts.isIdentifier(name) || ts.isStringLiteral(name))) {
          keys.push(name.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(parsed);
  return keys;
}

/** Every package under `packages/` that declares a `backend_config`, and the keys it declares. */
export function backendConfigDeclarations(): BackendConfigDeclaration[] {
  const found: BackendConfigDeclaration[] = [];
  for (const { name: pkg, dir } of entries(PACKAGES)) {
    if (!dir) continue;
    const keys = new Set<string>();
    for (const file of filesUnder(join(PACKAGES, pkg, 'src'), isSource)) {
      for (const key of declaredKeysIn(readFileSync(file, 'utf8'))) keys.add(key);
    }
    if (keys.size > 0) found.push({ pkg, keys: [...keys] });
  }
  return found.sort((a, b) => a.pkg.localeCompare(b.pkg));
}

/** Every `*.test.ts` under one package, concatenated — the text its refusal specs are written in. */
export function testSourcesOf(pkg: string): string {
  return filesUnder(join(PACKAGES, pkg), isTest)
    .map((file) => readFileSync(file, 'utf8'))
    .join('\n');
}

/**
 * Every key name a plugin hands `describeConfigValue` as a literal. Some are not `backend_config`
 * keys at all — a page size off a caller's `fetchRecent` — so the render policy has to cover them
 * without a hand-kept second list.
 */
export function keysRenderedByName(): string[] {
  const found = new Set<string>();
  for (const { name: pkg, dir } of entries(PACKAGES)) {
    if (!dir) continue;
    for (const file of filesUnder(join(PACKAGES, pkg, 'src'), isSource)) {
      for (const [, key] of readFileSync(file, 'utf8').matchAll(
        /describeConfigValue\(\s*'([^']+)'/g,
      )) {
        found.add(key as string);
      }
    }
  }
  return [...found].sort();
}
