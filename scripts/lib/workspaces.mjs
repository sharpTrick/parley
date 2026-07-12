// Single source of truth for "which workspaces the release publishes" and their registry state.
//
// Both scripts/publish-workspaces.mjs (the real release publish) and scripts/publish-preflight.mjs
// (the pre-merge guard) import this, so the preflight can never drift from what actually gets
// published — the whole point of a preflight is that it checks the *same* set.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

// Roots scanned for publishable packages. Private workspaces (examples/*) are filtered out below.
export const PUBLISH_ROOTS = ['packages', 'examples']

/** Every non-private workspace package.json under PUBLISH_ROOTS → { name, version, dir }. */
export function publicWorkspaces() {
  const out = []
  for (const root of PUBLISH_ROOTS) {
    if (!existsSync(root)) continue
    for (const dir of readdirSync(root)) {
      const pkgPath = join(root, dir, 'package.json')
      if (!existsSync(pkgPath)) continue
      const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
      if (pkg.private || !pkg.name) continue
      out.push({ name: pkg.name, version: pkg.version, dir: join(root, dir) })
    }
  }
  return out
}

/**
 * Whether a package NAME exists on the npm registry at all (any version). Read-only, no auth.
 * `npm view <name> version` exits non-zero with E404 when the package has never been published.
 * Returns 'present' | 'absent' | 'unknown' — 'unknown' is a network/registry hiccup, which callers
 * should treat as a warning, not a hard failure, so a flaky registry can't red a PR.
 */
export function registryStatus(name) {
  try {
    execFileSync('npm', ['view', name, 'version'], { stdio: ['ignore', 'ignore', 'pipe'] })
    return 'present'
  } catch (e) {
    const err = (e && e.stderr ? e.stderr.toString() : '') + (e && e.message ? e.message : '')
    if (/E404|404|not found|is not in this registry/i.test(err)) return 'absent'
    return 'unknown'
  }
}
