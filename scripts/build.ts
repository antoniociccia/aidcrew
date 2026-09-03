#!/usr/bin/env bun
/**
 * Builds the single-file executables.
 *
 *   bun scripts/build.ts                 the host platform, into dist/
 *   bun scripts/build.ts --all           every platform we publish
 *   bun scripts/build.ts --target=...    one named platform
 *
 * A build script rather than a `bun build` command line, because two module
 * substitutions have to happen and only the programmatic API takes plugins.
 * Both are things `bunfig.toml` does for `bun run` and cannot do for a compiled
 * binary, where there is no config file to read — so leaving them out would
 * produce a binary that is subtly worse than running from source, which is the
 * hardest kind of difference to notice.
 */

import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BunPlugin } from 'bun'

/**
 * The platforms we publish, named the way the release assets are.
 *
 * Windows was left out for a long time, and on purpose: every tool that does
 * anything spawns a program — `bash -c` for the shell, `git` for the checkouts
 * — and CI had only ever run on ubuntu, so a Windows binary would have been
 * published having never once been started, to die on its first tool call.
 * It is here because the release job now builds and starts the binary on each
 * platform before it publishes any of them, and the test beside this file
 * refuses a target without that. Where a tool needs `bash`, Windows needs Git
 * for Windows on the PATH; the Linux build under WSL is the better-worn road.
 */
/** The compile targets Bun names, narrowed from what this file lists. */
type Target = (typeof TARGETS)[number]['target']

export const TARGETS = [
  { target: 'bun-darwin-arm64', name: 'aidcrew-macos-arm64' },
  { target: 'bun-darwin-x64', name: 'aidcrew-macos-x64' },
  { target: 'bun-linux-x64', name: 'aidcrew-linux-x64' },
  { target: 'bun-linux-arm64', name: 'aidcrew-linux-arm64' },
  { target: 'bun-windows-x64', name: 'aidcrew-windows-x64.exe' },
] as const

/**
 * Ink's React DevTools bridge, which a compiled binary can never use.
 *
 * Ink imports it behind `if (process.env.DEV === 'true')`, but the bundler
 * still has to resolve what is inside the branch, and marking it external only
 * moves the failure to startup: the binary then looks for a package that is
 * not there and refuses to run at all.
 *
 * An empty module is honest here. The feature it serves is attaching a React
 * debugger to the interface, which is a thing you do from a checkout.
 */
const stubDevtools: BunPlugin = {
  name: 'aidcrew:no-devtools',
  setup(build) {
    build.onResolve({ filter: /^react-devtools-core$/ }, () => ({
      path: 'aidcrew:devtools-stub',
      namespace: 'aidcrew-stub',
    }))
    build.onLoad({ filter: /.*/, namespace: 'aidcrew-stub' }, () => ({
      contents: 'export default {}',
      loader: 'js',
    }))
  },
}

/**
 * Our width function, in place of the one Ink asks for.
 *
 * `bunfig.toml` does this for `bun run` and `bun test`. A binary reads no
 * bunfig, so without this the published `string-width` comes back and every
 * frame costs what it cost before we replaced it — around ninety milliseconds
 * for a screen of ordinary prose. See packages/fast-width for the measurement.
 */
const fastWidth: BunPlugin = {
  name: 'aidcrew:fast-width',
  setup(build) {
    build.onResolve({ filter: /^string-width$/ }, () => ({
      path: 'aidcrew:string-width',
      namespace: 'aidcrew-width',
    }))
    build.onLoad({ filter: /.*/, namespace: 'aidcrew-width' }, () => ({
      contents: `import { widthOf } from ${JSON.stringify(
        Bun.fileURLToPath(import.meta.resolve('../packages/fast-width/src/index.ts')),
      )}\nexport default widthOf`,
      loader: 'ts',
    }))
  },
}

async function build(target: Target, name: string, outdir: string): Promise<void> {
  const started = performance.now()

  const result = await Bun.build({
    entrypoints: ['packages/cli/src/bin.ts'],
    plugins: [stubDevtools, fastWidth],
    // Most of the weight is the Bun runtime and nothing can be done about
    // that; this is only our own bundle, and it is free.
    minify: true,
    define: { 'process.env.AIDCREW_VERSION': JSON.stringify(version()) },
    compile: { target, outfile: join(outdir, name) },
  })

  if (!result.success) {
    for (const log of result.logs) console.error(log)
    throw new Error(`could not build ${name}`)
  }

  const size = Bun.file(join(outdir, name)).size
  console.log(
    `${name.padEnd(28)} ${(size / 1024 / 1024).toFixed(1)} MB  ${Math.round(
      performance.now() - started,
    )}ms`,
  )
}

/** The version stamped into the binary, so `--version` is true of that build. */
function version(): string {
  const pkg = require('../packages/cli/package.json') as { version: string }
  return process.env.AIDCREW_VERSION ?? pkg.version
}

/**
 * Only when run, never when imported.
 *
 * Without this, importing anything from here — the list of platforms, say, so
 * a test can check it against what the README promises — deletes `dist` and
 * compiles a binary. A module that cannot be read without being run is a
 * module nothing checks.
 */
/**
 * Which of the platforms a run of this script builds.
 *
 * `--all` is every one; a target or an asset name, with or without
 * `--target=`, is that one; nothing named is this machine. Node calls the
 * platform `win32` where Bun's target says `windows`, which is how the
 * default built nothing on the one machine the release job runs to prove the
 * Windows binary starts — "no such target", listing the target it had just
 * failed to pick.
 */
export function targetsAsked(
  asked: string[],
  platform: string = process.platform,
  arch: string = process.arch,
): (typeof TARGETS)[number][] {
  if (asked.includes('--all')) return [...TARGETS]

  const named =
    asked.find((arg) => arg.startsWith('--target='))?.slice('--target='.length) ??
    asked.find((arg) => !arg.startsWith('--'))
  const target = named ?? `bun-${platform === 'win32' ? 'windows' : platform}-${arch}`

  return TARGETS.filter((entry) => entry.target === target || entry.name === target)
}

if (import.meta.main) {
  const asked = process.argv.slice(2)
  const outdir = 'dist'
  await rm(outdir, { recursive: true, force: true })

  const wanted = targetsAsked(asked)

  if (wanted.length === 0) {
    console.error(`no such target. Known: ${TARGETS.map((entry) => entry.target).join(', ')}`)
    process.exit(1)
  }

  console.log(`aidcrew ${version()}\n`)
  // One at a time: each compile writes a whole runtime to disk, and doing five
  // at once turns a laptop into a fan for no gain.
  for (const entry of wanted) await build(entry.target, entry.name, outdir)

  // Windows names its checksum file differently, and a release with one manifest
  // per platform is a release nobody can verify in a single step.
  const digests = await Promise.all(
    wanted.map(async (entry) => {
      const bytes = await Bun.file(join(outdir, entry.name)).arrayBuffer()
      const hash = new Bun.CryptoHasher('sha256').update(bytes).digest('hex')
      return `${hash}  ${entry.name}`
    }),
  )
  await Bun.write(join(outdir, 'checksums.txt'), `${digests.join('\n')}\n`)
  console.log(`\n${outdir}/checksums.txt`)
}
