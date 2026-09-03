import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPluginsFrom } from './loader.ts'
import { serveToPlugins } from './resolve.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-resolve-')))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

function plugin(name: string, source: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'index.ts'), source)
}

/**
 * A plugin lives outside this repository — in `~/.aidcrew/plugins` or in
 * somebody else's project — where nothing has ever run `bun install`. Every
 * example in the README starts with `import { definePlugin } from
 * '@aidcrew/plugin-sdk'`, and until this existed that import failed with
 * "Cannot find module": the documented way to write a plugin did not work,
 * and it was the first thing anyone would try.
 */
describe('what a plugin is allowed to import', () => {
  test('the SDK resolves from a directory that never installed anything', async () => {
    serveToPlugins({ 'test-sdk': { greet: () => 'hello from the host' } })
    plugin(
      'greeter',
      `import { greet } from 'test-sdk'
       export default { name: 'greeter', greeting: greet() }`,
    )

    const result = await loadPluginsFrom([root])

    expect(result.failed).toEqual([])
    expect((result.loaded[0] as { greeting?: string }).greeting).toBe('hello from the host')
  })

  test('a module served later is resolvable too', async () => {
    serveToPlugins({ 'test-first': { a: 1 } })
    serveToPlugins({ 'test-second': { b: 2 } })
    plugin(
      'both',
      `import { a } from 'test-first'
       import { b } from 'test-second'
       export default { name: 'both', sum: a + b }`,
    )

    const result = await loadPluginsFrom([root])

    expect(result.failed).toEqual([])
    expect((result.loaded[0] as { sum?: number }).sum).toBe(3)
  })

  test('anything else still fails, and says so plainly', async () => {
    plugin(
      'greedy',
      `import { anything } from 'some-package-nobody-has'
       export default { name: 'greedy', anything }`,
    )

    const result = await loadPluginsFrom([root])

    expect(result.loaded).toHaveLength(0)
    expect(result.failed[0]?.reason).toContain('some-package-nobody-has')
  })
})
