// Stamp one lockstep version across every workspace package.json (packages/* and examples/*),
// and rewrite internal @sharptrick/parley-* dependency ranges to ^<version> so a release's
// packages depend on each other's *new* versions, not the previous line.
//
// Runs in the CI working tree only — semantic-release's prepare step. Nothing is committed back:
// the git tag + npm are the source of truth for "current version".
//
//   node scripts/stamp-version.mjs 0.2.0
import { readFileSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'

const version = process.argv[2]
if (!version || !/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(version)) {
  console.error(`usage: stamp-version <semver>  (got: ${version ?? '<none>'})`)
  process.exit(1)
}

const ROOTS = ['packages', 'examples']
const INTERNAL = /^@sharptrick\/parley-/
const DEP_FIELDS = ['dependencies', 'devDependencies', 'peerDependencies', 'optionalDependencies']

for (const root of ROOTS) {
  if (!existsSync(root)) continue
  for (const dir of readdirSync(root)) {
    const pkgPath = join(root, dir, 'package.json')
    if (!existsSync(pkgPath)) continue

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    pkg.version = version
    for (const field of DEP_FIELDS) {
      const deps = pkg[field]
      if (!deps) continue
      for (const name of Object.keys(deps)) {
        if (INTERNAL.test(name)) deps[name] = `^${version}`
      }
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n')
    console.log(`stamped ${pkg.name} -> ${version}`)
  }
}
