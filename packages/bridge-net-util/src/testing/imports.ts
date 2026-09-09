import { codeOf, withoutComments } from './source-text.js';

/**
 * CLASS: "is this name still used?" answered by counting how often it is SPELLED. A guard written
 * that way turns red to green when somebody writes a comment naming the symbol — under this
 * repository's comment doctrine the cheapest artifact available — and it reads a property that
 * merely shares the name as a consumption. Resolve the question from the import SPECIFIER, so a
 * name counts only where it was actually bound.
 */

export interface ImportBinding {
  /** The module specifier, as written. */
  specifier: string;
  /** Names bound from the clause, aliases resolved to the LOCAL name. */
  names: string[];
  /** `import x from` / `import * as x from`, if either was used. */
  namespace?: string;
}

const CLAUSE =
  /\b(?:import|export)\s+(?:type\s+)?([\s\S]*?)\s*from\s*['"]([^'"\n]+)['"]|\bimport\s*\(\s*['"]([^'"\n]+)['"]\s*\)/g;

const bindings = (clause: string): { names: string[]; namespace?: string } => {
  const braces = /\{([\s\S]*?)\}/.exec(clause)?.[1] ?? '';
  const outside = clause.replace(/\{[\s\S]*?\}/, '').replace(/^type\s+/, '');
  const names = braces
    .split(',')
    .map((entry) => entry.trim().replace(/^type\s+/, ''))
    .map((entry) => (/\sas\s/.test(entry) ? entry.split(/\sas\s/)[1] : entry) ?? '')
    .map((entry) => entry.trim())
    .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry));
  const bare = outside
    .split(',')
    .map((entry) => entry.trim().replace(/^\*\s+as\s+/, ''))
    .filter((entry) => /^[A-Za-z_$][\w$]*$/.test(entry));
  return { names: [...names, ...bare], namespace: bare[0] };
};

/**
 * Every module a source loads, and the local names each one binds.
 *
 * Read off the comment-stripped text, with each match's own offset checked against the
 * literal-blanked text of the same length: an import SPELLED inside a string is a fixture quoting
 * one, and a rule that reads it as a binding flags the file that documents the rule.
 */
export function importsIn(source: string): ImportBinding[] {
  const text = withoutComments(source);
  const mask = codeOf(source);
  const out: ImportBinding[] = [];
  for (const m of text.matchAll(CLAUSE)) {
    const at = m.index;
    if (mask.slice(at, at + 6) !== text.slice(at, at + 6)) continue;
    if (m[3] !== undefined) {
      out.push({ specifier: m[3], names: [] });
      continue;
    }
    out.push({ specifier: m[2] as string, ...bindings(m[1] as string) });
  }
  return out;
}

/** The names a source binds from the modules `matches` accepts. */
export function importedNames(source: string, matches: (specifier: string) => boolean): Set<string> {
  const out = new Set<string>();
  for (const binding of importsIn(source)) {
    if (!matches(binding.specifier)) continue;
    for (const name of binding.names) out.add(name);
    const ns = binding.namespace;
    if (ns !== undefined)
      for (const read of withoutComments(source).matchAll(new RegExp(`\\b${ns}\\.(\\w+)`, 'g')))
        out.add(read[1] as string);
  }
  return out;
}

/**
 * The names a barrel PUBLISHES, including the type-only ones. A runtime key enumeration
 * (`Object.keys(await import(…))`) cannot see `export type { X }` — a `.d.ts` name is semver surface
 * with no runtime binding — so a guard built from one alone declares a type-only export unpublished
 * and lets an orphan through.
 */
export function exportedNames(barrel: string): Set<string> {
  const out = new Set<string>();
  const code = codeOf(barrel);
  for (const clause of code.matchAll(/\bexport\s+(?:type\s+)?\{([^}]*)\}/g))
    for (const spec of (clause[1] as string).split(',')) {
      const name = spec.replace(/^\s*type\s+/, '').split(/\s+as\s+/).pop()?.trim();
      if (name !== undefined && name !== '') out.add(name);
    }
  for (const declared of code.matchAll(
    /^export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(?:const|let|var|function|class|interface|type|enum)\s+(\w+)/gm,
  ))
    out.add(declared[1] as string);
  return out;
}

/** Which of `files` import `name` from a module `matches` accepts. */
export const consumersOf = (
  name: string,
  files: readonly { path: string; text: string }[],
  matches: (specifier: string) => boolean,
): string[] => files.filter((f) => importedNames(f.text, matches).has(name)).map((f) => f.path);
