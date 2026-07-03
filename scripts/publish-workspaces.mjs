// Publish every public workspace package to npm, idempotently.
//
// Each package is published one at a time with provenance via trusted publishing (OIDC —
// requires `permissions: id-token: write` and a trusted publisher configured per package at
// npmjs.com; no NPM_TOKEN). A package whose exact name@version is already on the registry is
// skipped, so a re-run after a partial/failed release safely finishes the remainder instead of
// erroring on the ones that made it out.
//
// Private workspaces (the examples/*) are skipped. Assumes versions were already stamped by
// scripts/stamp-version.mjs.
import { readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

const ROOTS = ['packages', 'examples']
let published = 0
let skipped = 0

for (const root of ROOTS) {
  if (!existsSync(root)) continue
  for (const dir of readdirSync(root)) {
    const pkgPath = join(root, dir, 'package.json')
    if (!existsSync(pkgPath)) continue

    const pkg = JSON.parse(readFileSync(pkgPath, 'utf8'))
    if (pkg.private) continue

    const spec = `${pkg.name}@${pkg.version}`

    // `npm view <spec> version` exits non-zero (E404) when the version isn't published yet.
    let alreadyPublished = false
    try {
      execFileSync('npm', ['view', spec, 'version'], { stdio: 'ignore' })
      alreadyPublished = true
    } catch {
      alreadyPublished = false
    }

    if (alreadyPublished) {
      console.log(`skip    ${spec} (already on registry)`)
      skipped++
      continue
    }

    console.log(`publish ${spec}`)
    execFileSync('npm', ['publish', '-w', pkg.name, '--provenance', '--access', 'public'], {
      stdio: 'inherit',
    })
    published++
  }
}

console.log(`done: ${published} published, ${skipped} skipped`)
