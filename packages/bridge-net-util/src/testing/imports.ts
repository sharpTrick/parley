import ts from 'typescript';
import { withoutComments } from './source-text.js';

/**
 * CLASS: "is this name still used?" answered by counting how often it is SPELLED. A guard written
 * that way turns red to green when somebody writes a comment naming the symbol — under this
 * repository's comment doctrine the cheapest artifact available — and it reads a property that
 * merely shares the name as a consumption. Resolve the question from the import SPECIFIER, so a
 * name counts only where it was actually bound.
 *
 * CLASS: five hand-rolled readers of the same grammar, disagreeing about aliases and about whether
 * `export … from` is an import. Read the grammar from the PARSER instead: an alias is
 * `ExportSpecifier.propertyName` against `.name`, and an import is a different node type from a
 * re-export, so neither distinction is a pattern that can be approximated wrongly.
 *
 * What a syntax-only pass still cannot see is a namespace read through a computed key
 * (`ns[k]`, `Object.entries(ns)`) or a destructure of one. Both fail toward "this export looks
 * DEAD", never toward "this violation looks clean"; closing them needs a type checker.
 */

export interface ImportBinding {
  /** The module specifier, as written. */
  specifier: string;
  /** `export … from` binds nothing locally and re-publishes instead; keep the two apart. */
  kind: 'import' | 'reexport';
  /** Names bound from the clause, aliases resolved to the LOCAL name. */
  names: string[];
  /** The same names as the module being read publishes them — the half before `as`. */
  sourceNames: string[];
  /** `import * as x from` / `export * as x from`, if either was used. */
  namespace?: string;
}

const parse = (source: string): ts.SourceFile =>
  ts.createSourceFile('scanned.ts', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

const literal = (node: ts.Node | undefined): string | undefined =>
  node !== undefined && ts.isStringLiteralLike(node) ? node.text : undefined;

/** Every module a source loads or re-publishes, and the names each one moves. */
export function importsIn(source: string): ImportBinding[] {
  const out: ImportBinding[] = [];
  const add = (b: ImportBinding): void => void out.push(b);
  const boundTo = new Map<ts.Node, string>();
  const walk = (node: ts.Node): void => {
    if (
      ts.isVariableDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      node.initializer !== undefined
    ) {
      const value = ts.isAwaitExpression(node.initializer)
        ? node.initializer.expression
        : node.initializer;
      boundTo.set(value, node.name.text);
    }
    if (ts.isImportDeclaration(node)) {
      const specifier = literal(node.moduleSpecifier);
      const clause = node.importClause;
      const named =
        clause?.namedBindings !== undefined && ts.isNamedImports(clause.namedBindings)
          ? clause.namedBindings.elements
          : [];
      const ns =
        clause?.namedBindings !== undefined && ts.isNamespaceImport(clause.namedBindings)
          ? clause.namedBindings.name.text
          : undefined;
      if (specifier !== undefined)
        add({
          specifier,
          kind: 'import',
          names: [
            ...(clause?.name === undefined ? [] : [clause.name.text]),
            ...(ns === undefined ? [] : [ns]),
            ...named.map((e) => e.name.text),
          ],
          sourceNames: [
            ...(clause?.name === undefined ? [] : ['default']),
            ...named.map((e) => (e.propertyName ?? e.name).text),
          ],
          ...(ns === undefined ? {} : { namespace: ns }),
        });
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier !== undefined) {
      const specifier = literal(node.moduleSpecifier);
      const clause = node.exportClause;
      const named = clause !== undefined && ts.isNamedExports(clause) ? clause.elements : [];
      const ns = clause !== undefined && ts.isNamespaceExport(clause) ? clause.name.text : undefined;
      if (specifier !== undefined)
        add({
          specifier,
          kind: 'reexport',
          names: [...(ns === undefined ? [] : [ns]), ...named.map((e) => e.name.text)],
          sourceNames: named.map((e) => (e.propertyName ?? e.name).text),
          ...(ns === undefined ? {} : { namespace: ns }),
        });
    } else if (ts.isImportEqualsDeclaration(node)) {
      const specifier = ts.isExternalModuleReference(node.moduleReference)
        ? literal(node.moduleReference.expression)
        : undefined;
      if (specifier !== undefined)
        add({
          specifier,
          kind: 'import',
          names: [node.name.text],
          sourceNames: [],
          namespace: node.name.text,
        });
    } else if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const dynamic =
        callee.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(callee) && callee.text === 'require');
      const specifier = dynamic ? literal(node.arguments[0]) : undefined;
      const ns = boundTo.get(node);
      if (specifier !== undefined)
        add({
          specifier,
          kind: 'import',
          names: ns === undefined ? [] : [ns],
          sourceNames: [],
          ...(ns === undefined ? {} : { namespace: ns }),
        });
    }
    ts.forEachChild(node, walk);
  };
  walk(parse(source));
  return out;
}

/** Whichever half of each binding `pick` reads, over the modules `matches` accepts. */
const namesFrom = (
  source: string,
  matches: (specifier: string) => boolean,
  pick: (binding: ImportBinding) => readonly string[],
): Set<string> => {
  const out = new Set<string>();
  for (const binding of importsIn(source)) {
    if (!matches(binding.specifier)) continue;
    for (const name of pick(binding)) out.add(name);
    const ns = binding.namespace;
    if (ns !== undefined)
      for (const read of withoutComments(source).matchAll(new RegExp(`\\b${ns}\\.(\\w+)`, 'g')))
        out.add(read[1] as string);
  }
  return out;
};

/**
 * The LOCAL names a source binds from the modules `matches` accepts — what an unused-import rule
 * asks, and the wrong question for "who consumes this export": a pure `import { x as y }` rename
 * is not a change to what the module next door publishes.
 */
export const importedNames = (source: string, matches: (specifier: string) => boolean): Set<string> =>
  namesFrom(source, matches, (b) => b.names);

/** The names a source takes FROM those modules, under the names those modules publish them. */
export const consumedNames = (source: string, matches: (specifier: string) => boolean): Set<string> =>
  namesFrom(source, matches, (b) => b.sourceNames);

/**
 * Which of `files` IMPORT `name` from a module `matches` accepts. A re-export moves a name onward
 * without anything needing it, so a barrel is not what keeps a symbol alive.
 */
export const consumersOf = (
  name: string,
  files: readonly { path: string; text: string }[],
  matches: (specifier: string) => boolean,
): string[] =>
  files
    .filter((f) =>
      namesFrom(f.text, matches, (b) => (b.kind === 'import' ? b.sourceNames : [])).has(name),
    )
    .map((f) => f.path);

const modifiers = (node: ts.Node): readonly ts.Modifier[] =>
  ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];

const marked = (node: ts.Node, kind: ts.SyntaxKind): boolean =>
  modifiers(node).some((m) => m.kind === kind);

/** The names a module DECLARES with an `export` modifier, in source order. */
export function declaredExports(source: string): string[] {
  const out: string[] = [];
  for (const node of parse(source).statements) {
    if (!marked(node, ts.SyntaxKind.ExportKeyword) || marked(node, ts.SyntaxKind.DefaultKeyword))
      continue;
    if (ts.isVariableStatement(node)) {
      for (const d of node.declarationList.declarations)
        if (ts.isIdentifier(d.name)) out.push(d.name.text);
      continue;
    }
    const named = node as { name?: ts.Node };
    if (named.name !== undefined && ts.isIdentifier(named.name)) out.push(named.name.text);
  }
  return out;
}

/** The modules a barrel republishes WHOLESALE, whose names it therefore cannot enumerate. */
export const starReexports = (source: string): string[] =>
  parse(source)
    .statements.filter(
      (s): s is ts.ExportDeclaration =>
        ts.isExportDeclaration(s) && s.exportClause === undefined && s.moduleSpecifier !== undefined,
    )
    .map((s) => literal(s.moduleSpecifier) as string);

/**
 * The names a barrel PUBLISHES, including the type-only ones and `default`. A runtime key
 * enumeration (`Object.keys(await import(…))`) cannot see `export type { X }` — a `.d.ts` name is
 * semver surface with no runtime binding — so a guard built from one alone declares a type-only
 * export unpublished and lets an orphan through. What a wholesale `export * from` republishes is
 * NOT here: read {@link starReexports} and follow it, or ban it.
 */
export function exportedNames(barrel: string): Set<string> {
  const out = new Set<string>(declaredExports(barrel));
  for (const node of parse(barrel).statements) {
    if (ts.isExportAssignment(node) || marked(node, ts.SyntaxKind.DefaultKeyword))
      out.add('default');
    else if (ts.isExportDeclaration(node) && node.exportClause !== undefined) {
      if (ts.isNamespaceExport(node.exportClause)) out.add(node.exportClause.name.text);
      else for (const e of node.exportClause.elements) out.add(e.name.text);
    }
  }
  return out;
}

/**
 * The names a source IMPORTS and then never references. An unused import asserts a dependency edge
 * on a symbol no code needs, pointing the next reader at the wrong place for a decision, and
 * nothing else here catches one: `tsconfig.base.json` sets neither `noUnusedLocals` nor
 * `noUnusedParameters`, and there is no linter.
 *
 * A reference is an IDENTIFIER outside the import statements, so a name kept alive only by a
 * comment or by a string that quotes the import is not one.
 */
export function unusedImports(source: string): string[] {
  const used = new Set<string>();
  const collect = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) || ts.isImportEqualsDeclaration(node)) return;
    if (ts.isIdentifier(node)) used.add(node.text);
    ts.forEachChild(node, collect);
  };
  ts.forEachChild(parse(source), collect);
  return importsIn(source)
    .filter((binding) => binding.kind === 'import')
    .flatMap((binding) => binding.names)
    .filter((name) => !used.has(name));
}
