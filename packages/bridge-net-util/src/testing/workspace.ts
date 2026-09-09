import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * CLASS: thirteen independent walks of the same tree, six independent derivations of "the package
 * set", three of them disagreeing. A guard is only ever as good as the universe it is applied to,
 * and a universe re-derived per file is one that narrows in silence — a flat `readdirSync` keeps
 * passing the day a package grows a subdirectory, and `name.endsWith('Plugin')` finds a different
 * set of backends from the one its neighbour finds structurally.
 *
 * One derivation, here, with the root DISCOVERED rather than counted out in `../`, so the same
 * module answers the same way from `src/` and from `dist/`.
 */

export interface Manifest {
  name?: string;
  private?: boolean;
  workspaces?: string[];
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  publishConfig?: { access?: string };
  exports?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface WorkspacePackage {
  /** Absolute directory holding the manifest. */
  dir: string;
  /** Path from the repository root, e.g. `packages/bridge-core`. */
  relative: string;
  /** Directory basename, e.g. `bridge-core`. */
  folder: string;
  /** Manifest `name`, e.g. `@sharptrick/parley-core`. */
  name: string;
  manifest: Manifest;
}

/** The package a backend declares to say it is one. */
export const SUITE = '@sharptrick/parley-conformance';

const read = (path: string): Manifest => JSON.parse(readFileSync(path, 'utf8')) as Manifest;

/** The nearest ancestor declaring `workspaces` — the repository root, wherever this module runs from. */
export function workspaceRoot(from: string = fileURLToPath(import.meta.url)): string {
  for (let dir = statSync(from).isDirectory() ? from : dirname(from); ; dir = dirname(dir)) {
    const manifest = join(dir, 'package.json');
    if (existsSync(manifest) && read(manifest).workspaces !== undefined) return dir;
    if (dirname(dir) === dir) throw new Error(`no workspace root above ${from}`);
  }
}

/** The declared workspace areas, `packages/*` reduced to `packages`. */
export function workspaceAreas(root: string = workspaceRoot()): string[] {
  return [...new Set(read(join(root, 'package.json')).workspaces?.map((w) => w.replace(/\/\*+$/, '')) ?? [])];
}

/** Every workspace package, from the manifest's own declaration of where they live. */
export function workspacePackages(root: string = workspaceRoot()): WorkspacePackage[] {
  return workspaceAreas(root)
    .flatMap((area) => {
      const at = join(root, area);
      if (!existsSync(at)) return [];
      return readdirSync(at)
        .map((folder) => ({ folder, dir: join(at, folder), relative: `${area}/${folder}` }))
        .filter(({ dir }) => statSync(dir).isDirectory() && existsSync(join(dir, 'package.json')));
    })
    .map((p) => {
      const manifest = read(join(p.dir, 'package.json'));
      return { ...p, name: manifest.name ?? p.folder, manifest };
    })
    .sort((a, b) => a.relative.localeCompare(b.relative));
}

/**
 * The backends, STRUCTURALLY: a package that declares the shared conformance suite. Derived rather
 * than pattern-matched on an export name, so a backend that renames its plugin class is one this
 * set still holds.
 */
export const backendPackages = (root?: string): WorkspacePackage[] =>
  workspacePackages(root).filter(
    (p) => SUITE in { ...p.manifest.dependencies, ...p.manifest.devDependencies },
  );

const NEVER_WALKED = new Set(['node_modules', 'dist', '.git', 'coverage']);

/** Every file under `dir`, recursively, filtered by extension. Never a flat listing. */
export function filesUnder(
  dir: string,
  extensions: readonly string[] = ['.ts'],
  out: string[] = [],
): string[] {
  if (!existsSync(dir)) return out;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!NEVER_WALKED.has(entry.name)) filesUnder(full, extensions, out);
    } else if (extensions.includes(extname(entry.name))) out.push(full);
  }
  return out;
}
