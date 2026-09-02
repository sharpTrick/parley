/**
 * The set of source files a scan is allowed to grade — DERIVED from the same tsconfig the build
 * compiles, never enumerated by hand or by walking one directory level.
 *
 * Four scans in this suite used to call `readdirSync(srcDir)`, which is not recursive, while
 * `tsconfig.json` compiles `src/**` and ships whatever it finds. A module in a subdirectory was
 * therefore invisible to the README scope-table parity check, the "asks for no listing scope"
 * check, the 'Used by' reachability check and the unused-import lint — all four still green, all
 * four grading a tree that no longer held the code they were written about. A planted
 * `src/scopes/extra.ts` calling `conversations.list` reached `dist/` with 174 tests passing.
 *
 * Deriving the universe from the build's own `include` is what keeps the two from drifting again:
 * there is no second list to update. The floor is what keeps a scan that has stopped finding
 * anything from passing by finding nothing.
 */
import { readFileSync } from 'node:fs';
import { dirname, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

export interface SourceModule {
  /** Path relative to the tsconfig, POSIX-separated — a stable test title and offender label. */
  name: string;
  path: string;
  text: string;
}

/**
 * Every `.ts` file the project at `configPath` compiles, as absolute paths. A config that cannot be
 * read, or whose `include` expands to fewer than two files, is a THROW: this function exists to be
 * the floor under every scan built on it, and a scan whose universe silently emptied is exactly the
 * failure it is here to prevent.
 */
export function compiledSourcePaths(configPath: string): string[] {
  const host: ts.ParseConfigFileHost = {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      const detail = ts.flattenDiagnosticMessageText(d.messageText, ' ');
      throw new Error(`unreadable tsconfig ${configPath}: ${detail}`);
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(configPath, {}, host);
  if (parsed === undefined) throw new Error(`unreadable tsconfig ${configPath}`);
  if (parsed.errors.length > 0) {
    throw new Error(
      `tsconfig ${configPath} did not parse: ${parsed.errors
        .map((d) => ts.flattenDiagnosticMessageText(d.messageText, ' '))
        .join('; ')}`,
    );
  }
  const files = parsed.fileNames.filter((f) => f.endsWith('.ts') && !f.endsWith('.d.ts'));
  if (files.length < 2) {
    throw new Error(
      `tsconfig ${configPath} compiles ${files.length} source file(s); the scan has gone blind`,
    );
  }
  return files.sort();
}

/** {@link compiledSourcePaths}, read and labelled by their path relative to the tsconfig. */
export function compiledSourceModules(configPath: string): SourceModule[] {
  const root = dirname(configPath);
  return compiledSourcePaths(configPath).map((path) => ({
    name: relative(root, path).split(sep).join('/'),
    path,
    text: readFileSync(path, 'utf8'),
  }));
}

const SLACK_TSCONFIG = fileURLToPath(new URL('../tsconfig.json', import.meta.url));

/** Every module the published `dist/` is built from. The universe every source scan here grades. */
export const slackSourceModules = (): SourceModule[] => compiledSourceModules(SLACK_TSCONFIG);

/** The same modules concatenated — for scans that look for one declaration anywhere in the tree. */
export const slackSourceText = (): string =>
  slackSourceModules()
    .map((m) => m.text)
    .join('\n');
