import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { TARGETS, targetsAsked } from './build.ts'

const root = join(import.meta.dir, '..')
const readme = readFileSync(join(root, 'README.md'), 'utf8')
const release = readFileSync(join(root, '.github', 'workflows', 'release.yml'), 'utf8')

describe('the platforms we publish', () => {
  test('are macOS, Linux and Windows, named the way the assets are', () => {
    const names = TARGETS.map((one) => one.name)

    expect(names).toEqual([
      'aidcrew-macos-arm64',
      'aidcrew-macos-x64',
      'aidcrew-linux-x64',
      'aidcrew-linux-arm64',
      'aidcrew-windows-x64.exe',
    ])
  })

  test('are the platforms the README says they are', () => {
    // The two drifted once and nobody noticed, because nothing read both.
    const promised = /Builds are published for ([^.]+)\./.exec(readme)?.[1]?.toLowerCase() ?? ''

    for (const family of ['macos', 'linux', 'windows']) {
      expect(TARGETS.some((one) => one.name.includes(family))).toBe(true)
      expect(promised).toContain(family)
    }
  })

  test('each ship only from a release that started the binary on that platform', () => {
    // Every tool that does anything spawns a program — `bash -c` for the
    // shell, `git` for the checkouts — and for a long time nothing had ever
    // run the binary anywhere but ubuntu. A Windows build was refused on
    // exactly that ground: published having never once been started, it
    // would die on its first tool call and turn a curious person into a
    // one-star bug report. The ground is gone now because the release job
    // starts a natively built binary on each platform before it publishes
    // anything — and this test is what keeps that from quietly going away.
    for (const platform of ['windows', 'macos', 'ubuntu']) {
      expect(release).toContain(`runs-on: ${platform}-latest`)
    }
    expect(release).toMatch(/aidcrew-windows-x64\.exe --version/)
    expect(release).toMatch(/aidcrew-macos-arm64 --version/)
    // Publishing waits for those runs: a release is not a race.
    expect(release).toMatch(/needs:\s*\[?\s*(check|windows|macos)/)
  })
})

describe('which platforms a run of the script builds', () => {
  const names = (asked: string[], platform = 'darwin', arch = 'arm64') =>
    targetsAsked(asked, platform, arch).map((one) => one.name)

  test('all of them, when asked for all', () => {
    expect(names(['--all'])).toEqual(TARGETS.map((one) => one.name))
  })

  test('the one named, by target or by asset name, with or without --target=', () => {
    expect(names(['--target=bun-linux-arm64'])).toEqual(['aidcrew-linux-arm64'])
    expect(names(['bun-windows-x64'])).toEqual(['aidcrew-windows-x64.exe'])
    expect(names(['aidcrew-macos-x64'])).toEqual(['aidcrew-macos-x64'])
  })

  test('this machine, when nothing is named — including a Windows machine', () => {
    // Node calls the platform `win32` and Bun calls the target `windows`, so
    // the default built nothing on the one machine the release job runs to
    // prove the Windows binary starts: "no such target", listing the target
    // it had just failed to pick.
    expect(names([], 'darwin', 'arm64')).toEqual(['aidcrew-macos-arm64'])
    expect(names([], 'linux', 'x64')).toEqual(['aidcrew-linux-x64'])
    expect(names([], 'win32', 'x64')).toEqual(['aidcrew-windows-x64.exe'])
  })

  test('nothing, for a name that is not a platform', () => {
    expect(names(['bun-freebsd-x64'])).toEqual([])
  })
})
