// Pre-merge release preflight — catch, BEFORE a PR lands, the release-time failures that would
// otherwise only surface post-merge when release.yml runs `semantic-release` on main.
//
// It checks, for every public workspace package (the same set scripts/publish-workspaces.mjs
// actually publishes — see scripts/lib/workspaces.mjs):
//
//   1. NEW-PACKAGE GATE  (the failure that motivated this — a v0.8.0 release that published 4 of
//      13 packages and died). A package that is not yet on the npm registry CANNOT be published by
//      the automated OIDC/trusted-publishing release: trusted publishing can only be configured on
//      a package that already exists, so its first publish must be a manual bootstrap
//      (CONTRIBUTING.md → "First publish of a brand-new package"). If we only learn this after
//      merge, the release splits the registry across versions. Fail here so the author bootstraps
//      the package (or marks it private) first.
//
//   2. PACKABILITY       `npm pack --dry-run` must succeed for each package (catches a missing
//      dist/, a bad "files" list, a failing prepack, etc.). pack does not contact the registry, so
//      it needs no auth AND — unlike `npm publish --dry-run` — it won't false-positive on the
//      committed 0.1.0 placeholder version colliding with what's already published (semantic-release
//      stamps the real version at release time; the committed version is always the placeholder).
//
// Read-only against the registry; safe to run locally (`npm run preflight:publish`) or in CI.
// Exit non-zero if any package is missing from the registry or fails to pack.
import { execFileSync } from 'node:child_process'
import { publicWorkspaces, registryStatus } from './lib/workspaces.mjs'

const pkgs = publicWorkspaces()
if (pkgs.length === 0) {
  console.error('preflight: found no public workspace packages — is this the repo root?')
  process.exit(1)
}

const missing = [] // never published — the automated release can't create these
const unknown = [] // registry hiccup — warn, don't fail
const unpackable = [] // `npm publish --dry-run` failed

for (const { name } of pkgs) {
  const status = registryStatus(name)
  if (status === 'absent') missing.push(name)
  else if (status === 'unknown') unknown.push(name)
}

for (const { name } of pkgs) {
  try {
    execFileSync('npm', ['pack', '-w', name, '--dry-run'], { stdio: ['ignore', 'ignore', 'pipe'] })
  } catch (e) {
    unpackable.push({ name, err: (e && e.stderr ? e.stderr.toString() : e && e.message) || '' })
  }
}

const ok = `${pkgs.length - missing.length - unknown.length} on registry`
console.log(`preflight: ${pkgs.length} public packages — ${ok}, ${missing.length} new, ${unpackable.length} unpackable`)

for (const name of unknown) {
  console.warn(`  ⚠ ${name}: could not reach the registry to confirm it exists (network?) — not failing on this`)
}

if (unpackable.length) {
  console.error('\n✘ These packages fail `npm publish --dry-run` (they would break the release publish):')
  for (const { name, err } of unpackable) {
    console.error(`  - ${name}`)
    const lines = err.split('\n').filter((l) => l.trim())
    const line = lines.filter((l) => /npm error|ERR!/i.test(l)).pop() || lines.pop()
    if (line) console.error(`      ${line.trim()}`)
  }
}

if (missing.length) {
  console.error('\n✘ These public packages are NOT on the npm registry yet:')
  for (const name of missing) console.error(`  - ${name}`)
  console.error(
    '\n  The automated release (release.yml → semantic-release) publishes with OIDC / trusted\n' +
      '  publishing, which can only be configured on a package that ALREADY exists. A brand-new\n' +
      '  package therefore needs a one-time manual bootstrap before it can go through automation,\n' +
      '  or the release will publish some packages and die on the new one (splitting the registry).\n' +
      '\n' +
      '  Fix before merging (see CONTRIBUTING.md → "First publish of a brand-new package"):\n' +
      '    • bootstrap it once:  npm publish -w <name> --access public   (from this branch; no provenance),\n' +
      '      then add its trusted publisher on npmjs.com (repo sharpTrick/parley, workflow release.yml);\n' +
      '    • or, if it should not ship, mark it "private": true in its package.json.',
  )
}

process.exit(missing.length || unpackable.length ? 1 : 0)
