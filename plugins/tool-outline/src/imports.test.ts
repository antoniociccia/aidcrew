import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { importsTool } from './imports.ts'

let root: string

function make(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-imports-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = async (input: object) =>
  await importsTool.execute(input, {
    cwd: root,
    agentId: 'test',
    signal: new AbortController().signal,
  })

const lines = (content: string) => content.split('\n')

describe('imports', () => {
  test('lists every module a file imports, each once, however it is imported', async () => {
    make({
      'a.ts': [
        "import fs from 'node:fs'",
        "import { a, b } from './ab.ts'",
        "import * as ns from '../ns.ts'",
        "import type { T } from './types.ts'",
        "import './side-effect.css'",
        'import {',
        '  one,',
        '  two,',
        "} from './multi.ts'",
        "export { x } from './re.ts'",
        "export * from './star.ts'",
        'async function later() {',
        "  const lazy = await import('./lazy.ts')",
        "  const old = require('legacy')",
        "  const again = await import('./lazy.ts')",
        '}',
      ].join('\n'),
    })

    const { content } = await run({ path: 'a.ts' })

    expect(lines(content)).toEqual([
      'node:fs',
      './ab.ts',
      '../ns.ts',
      './types.ts',
      './side-effect.css',
      './multi.ts',
      './re.ts',
      './star.ts',
      './lazy.ts',
      'legacy',
    ])
  })

  test('ignores an import that is quoted in a comment or a string', async () => {
    make({
      'a.ts': [
        "// import { nope } from './nope.ts'",
        'const s = "import { nope } from \'./nope.ts\'"',
        "import { yes } from './yes.ts'",
      ].join('\n'),
    })

    const { content } = await run({ path: 'a.ts' })

    expect(content).toBe('./yes.ts')
  })

  test('says so when a file imports nothing', async () => {
    make({ 'a.ts': 'export const a = 1\n' })

    const { content, isError } = await run({ path: 'a.ts' })

    expect(content).toContain('imports nothing')
    expect(isError).toBeUndefined()
  })

  describe('whoImports', () => {
    test('finds the files that import a file by relative path, however they spell it', async () => {
      make({
        'src/agents/workspace.ts': 'export const w = 1\n',
        'src/agents/host.ts': "import { w } from './workspace.ts'\n", // exact
        'src/agents/team.ts': "import { w } from './workspace'\n", // no extension
        'src/agents/fleet.ts': "import { w } from './workspace.js'\n", // js for ts, as tsc wants
        'src/index.ts': "export { w } from './agents/workspace.ts'\n", // re-export, from a parent
        'src/agents/other.ts': "import { x } from './workspace-other.ts'\n", // a different file
        'src/agents/workspace.test.ts': "import { w } from './workspace.ts'\n",
        'src/unrelated.ts': "import { z } from './z.ts'\n",
      })

      const { content } = await run({ path: 'src/agents/workspace.ts', whoImports: true })

      expect(lines(content).sort()).toEqual([
        'src/agents/fleet.ts:1',
        'src/agents/host.ts:1',
        'src/agents/team.ts:1',
        'src/agents/workspace.test.ts:1',
        'src/index.ts:1',
      ])
    })

    test('knows a directory import means its index file', async () => {
      make({
        'src/lib/index.ts': 'export const lib = 1\n',
        'src/a.ts': "import { lib } from './lib'\n",
        'src/b.ts': "import { lib } from './lib/index.ts'\n",
      })

      const { content } = await run({ path: 'src/lib/index.ts', whoImports: true })

      expect(lines(content).sort()).toEqual(['src/a.ts:1', 'src/b.ts:1'])
    })

    test('finds imports by package name when the file is what the package exports', async () => {
      make({
        'package.json': '{ "name": "mono", "workspaces": ["packages/*"] }',
        'packages/core/package.json':
          '{ "name": "@mono/core", "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" } }',
        'packages/core/src/index.ts': 'export const core = 1\n',
        'packages/core/src/agents/host.ts': 'export const host = 1\n',
        'packages/legacy/package.json': '{ "name": "@mono/legacy", "main": "./lib/main.js" }',
        'packages/legacy/lib/main.js': 'module.exports = {}\n',
        'packages/cli/src/a.ts': "import { core } from '@mono/core'\n",
        'packages/cli/src/b.ts': "import { host } from '@mono/core/agents/host'\n",
        'packages/cli/src/c.ts': "const legacy = require('@mono/legacy')\n",
        'packages/cli/src/d.ts': "import { other } from '@mono/core/other'\n",
      })

      const entry = await run({ path: 'packages/core/src/index.ts', whoImports: true })
      expect(lines(entry.content)).toEqual(['packages/cli/src/a.ts:1'])

      const sub = await run({ path: 'packages/core/src/agents/host.ts', whoImports: true })
      expect(lines(sub.content)).toEqual(['packages/cli/src/b.ts:1'])

      const main = await run({ path: 'packages/legacy/lib/main.js', whoImports: true })
      expect(lines(main.content)).toEqual(['packages/cli/src/c.ts:1'])
    })

    test('says so when nothing imports the file', async () => {
      make({ 'a.ts': 'export const a = 1\n', 'b.ts': "import './c.ts'\n" })

      const { content, isError } = await run({ path: 'a.ts', whoImports: true })

      expect(content).toContain('nothing in the workspace imports a.ts')
      expect(isError).toBeUndefined()
    })

    test('does not look in what nobody means', async () => {
      make({
        'a.ts': 'export const a = 1\n',
        'node_modules/pkg/index.ts': "import { a } from '../../a.ts'\n",
        'dist/b.js': "import { a } from '../a.ts'\n",
      })

      expect((await run({ path: 'a.ts', whoImports: true })).content).toContain('nothing')
    })

    test('stops at a hundred importers and says so', async () => {
      const files: Record<string, string> = { 'a.ts': 'export const a = 1\n' }
      for (let at = 0; at < 105; at += 1) files[`f${at}.ts`] = "import { a } from './a.ts'\n"
      make(files)

      const { content } = await run({ path: 'a.ts', whoImports: true })

      expect(lines(content).filter((line) => line.startsWith('f')).length).toBe(100)
      expect(content).toContain('more')
    })
  })

  test('refuses a directory, since imports is about one file', async () => {
    make({ 'src/a.ts': '' })

    const { content, isError } = await run({ path: 'src' })

    expect(isError).toBe(true)
    expect(content).toContain('directory')
  })

  test('returns a failure the model can read for a file that is not there', async () => {
    make({ 'a.ts': '' })

    const { content, isError } = await run({ path: 'missing.ts' })

    expect(isError).toBe(true)
    expect(content).toContain('missing.ts')
  })

  test('never leaves the workspace', async () => {
    make({ 'a.ts': '' })

    expect((await run({ path: '../../etc/hosts' })).content).toContain('escapes the workspace')
  })
})
