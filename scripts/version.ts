#!/usr/bin/env bun
/**
 * Sets the version, commits it, and tags it.
 *
 *   bun scripts/version.ts 0.2.0
 *   bun scripts/version.ts minor        major | minor | patch
 *
 * Then `git push --follow-tags`, and the tag is what builds the release.
 *
 * One place holds the number — the CLI package — and the tag is checked
 * against it in CI. Two places would disagree eventually, and a release whose
 * binary reports a different version than its tag is a bug report nobody can
 * act on.
 */

import { $ } from 'bun'

const PACKAGE = 'packages/cli/package.json'
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

const asked = process.argv[2]
if (!asked) {
  console.error('usage: bun scripts/version.ts <version | major | minor | patch>')
  process.exit(1)
}

const pkg = (await Bun.file(PACKAGE).json()) as { version: string }
const next = resolve(asked, pkg.version)

if (!SEMVER.test(next)) {
  console.error(`"${next}" is not a version. Three numbers, no prefix: 1.4.0`)
  process.exit(1)
}

// A dirty tree would put whatever else is lying around into the release
// commit, and a release is the one commit that has to be exactly what it says.
const dirty = (await $`git status --porcelain`.text()).trim()
if (dirty !== '') {
  console.error(`the working tree has uncommitted changes:\n${dirty}`)
  process.exit(1)
}

const source = await Bun.file(PACKAGE).text()
await Bun.write(PACKAGE, source.replace(`"version": "${pkg.version}"`, `"version": "${next}"`))

await $`git add ${PACKAGE}`
await $`git commit -q -m ${`release: ${next}`}`
await $`git tag ${`v${next}`}`

console.log(`${pkg.version} → ${next}\n\nPush it with:\n  git push --follow-tags`)

/** A whole version, or a step from the one we are on. */
function resolve(given: string, current: string): string {
  const parts = current.split('.').map(Number)
  const [major = 0, minor = 0, patch = 0] = parts

  if (given === 'major') return `${major + 1}.0.0`
  if (given === 'minor') return `${major}.${minor + 1}.0`
  if (given === 'patch') return `${major}.${minor}.${patch + 1}`
  return given.replace(/^v/, '')
}
