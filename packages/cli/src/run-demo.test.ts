import { describe, expect, test } from 'bun:test'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { demoIntro, demoOutro, demoPlugin, plantDemoProject } from './run-demo.ts'

describe('sixty seconds to a working agent', () => {
  test('plants a project whose check really fails', async () => {
    // A task rather than a puzzle: the agent can tell whether it is done, and
    // so can the person watching. A demo that cannot fail cannot succeed
    // either.
    const repo = await plantDemoProject()
    try {
      expect(readFileSync(join(repo, 'math.js'), 'utf8')).toContain('a - b')
      expect(existsSync(join(repo, 'check.sh'))).toBe(true)

      const check = Bun.spawnSync(['./check.sh'], { cwd: repo })
      expect(check.exitCode).toBe(1)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the check needs no runtime the binary does not already have', async () => {
    // aidcrew ships as a single Bun-compiled binary, and this demo exists so
    // somebody who has installed nothing else can try it. A check.sh that
    // shells out to `node` breaks the demo on exactly that machine — not
    // with "the bug is still there" but with exit code 127, which the outro
    // then reports as a bug in aidcrew. A stripped PATH is the proof: bash
    // is the one thing #!/bin/bash already requires.
    const repo = await plantDemoProject()
    try {
      const stripped = Bun.spawnSync(['./check.sh'], {
        cwd: repo,
        env: { PATH: '/usr/bin:/bin' },
      })

      expect(stripped.exitCode).toBe(1)
    } finally {
      rmSync(repo, { recursive: true, force: true })
    }
  })

  test('the model that does not exist arrives as a plugin, like everything else', () => {
    // It would have been shorter to hand the loop a provider. Going through
    // the registry is the claim the README makes, demonstrated in the one
    // place a newcomer is certain to run.
    const plugin = demoPlugin()

    expect(plugin.providers?.[0]?.id).toBe('demo')
    expect(plugin.providers?.[0]?.needsKey).toBe(false)
  })

  test('it needs no key, which is the whole point', () => {
    const built = demoPlugin().providers?.[0]?.create({})

    expect(built?.id).toBe('demo')
  })

  test('says what to do next, with a key of your own', () => {
    expect(demoOutro('/tmp/x', true)).toContain('aidcrew config set-key')
  })

  test('says plainly when the demo itself did not work', async () => {
    // Not "something went wrong". A demo that ends without a working check is
    // a bug in the harness, and saying so is the difference between a report
    // and a shrug.
    expect(demoOutro('/tmp/x', false)).toContain('bug in aidcrew')
  })

  test('names the directory, so it can be looked at and deleted', () => {
    expect(demoIntro('/tmp/here')).toContain('/tmp/here')
    expect(demoOutro('/tmp/here', true)).toContain('/tmp/here')
  })
})
