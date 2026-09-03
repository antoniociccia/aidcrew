import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { depsTool } from './deps.ts'

let root: string

function make(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-deps-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = async (input: object) =>
  await depsTool.execute(input, {
    cwd: root,
    agentId: 'test',
    signal: new AbortController().signal,
  })

const monorepo = {
  'package.json': JSON.stringify({
    name: 'mono',
    workspaces: ['packages/*', 'plugins/*'],
    dependencies: { '@mono/cli': 'workspace:*' },
  }),
  'packages/core/package.json': JSON.stringify({
    name: '@mono/core',
    version: '0.3.0',
    dependencies: { zod: '^4.0.0', ink: '^7.1.1' },
    devDependencies: { '@types/react': '^19.0.0' },
  }),
  'packages/cli/package.json': JSON.stringify({
    name: '@mono/cli',
    dependencies: { '@mono/core': 'workspace:*' },
  }),
  'plugins/tool-x/package.json': JSON.stringify({
    name: '@mono/tool-x',
    devDependencies: { '@mono/core': 'workspace:*' },
  }),
  'plugins/tool-y/package.json': JSON.stringify({
    name: '@mono/tool-y',
    peerDependencies: { '@mono/core': '*' },
  }),
  'packages/other/package.json': JSON.stringify({ name: '@mono/other' }),
  'node_modules/@mono/fake/package.json': JSON.stringify({
    name: '@mono/fake',
    dependencies: { '@mono/core': '*' },
  }),
  'elsewhere/package.json': JSON.stringify({
    name: 'not-a-workspace',
    dependencies: { '@mono/core': '*' },
  }),
}

describe('deps', () => {
  test('lists what a package depends on, with versions, and what depends on it', async () => {
    make(monorepo)

    const { content } = await run({ path: 'packages/core' })

    expect(content).toBe(
      [
        '@mono/core 0.3.0 (packages/core)',
        'dependencies:',
        '  ink ^7.1.1',
        '  zod ^4.0.0',
        'devDependencies:',
        '  @types/react ^19.0.0',
        'depended on by:',
        '  @mono/cli (packages/cli) dependencies',
        '  @mono/tool-x (plugins/tool-x) devDependencies',
        '  @mono/tool-y (plugins/tool-y) peerDependencies',
      ].join('\n'),
    )
  })

  test('finds dependents only through the workspaces the root declares', async () => {
    make(monorepo)

    const { content } = await run({ path: 'packages/core' })

    // A copy under node_modules and a package.json outside every workspace
    // glob are not members of the monorepo, whatever they say they need.
    expect(content).not.toContain('@mono/fake')
    expect(content).not.toContain('not-a-workspace')
  })

  test('counts the root package as a dependent when it is one', async () => {
    make(monorepo)

    const { content } = await run({ path: 'packages/cli' })

    expect(content).toContain('mono (.) dependencies')
  })

  test('says so when a package needs nothing and nothing needs it', async () => {
    make(monorepo)

    const { content } = await run({ path: 'packages/other' })

    expect(content).toContain('dependencies: none')
    expect(content).toContain('devDependencies: none')
    expect(content).toContain('depended on by: nothing in the workspace')
  })

  test('accepts the package.json itself as the path', async () => {
    make(monorepo)

    expect((await run({ path: 'packages/core/package.json' })).content).toContain('@mono/core')
  })

  test('says when there is no workspaces field to find dependents through', async () => {
    make({
      'package.json': JSON.stringify({ name: 'single' }),
      'lib/package.json': JSON.stringify({ name: 'lib', dependencies: { zod: '^4' } }),
    })

    const { content } = await run({ path: 'lib' })

    expect(content).toContain('zod ^4')
    expect(content).toContain('no "workspaces"')
  })

  test('fails readably when the directory has no package.json', async () => {
    make({ 'src/a.ts': '' })

    const { content, isError } = await run({ path: 'src' })

    expect(isError).toBe(true)
    expect(content).toContain('no package.json')
  })

  test('fails readably when the package.json is not JSON', async () => {
    make({ 'pkg/package.json': '{ oops' })

    const { content, isError } = await run({ path: 'pkg' })

    expect(isError).toBe(true)
    expect(content).toContain('not valid JSON')
  })

  test('never leaves the workspace', async () => {
    make({ 'package.json': '{}' })

    expect((await run({ path: '../..' })).content).toContain('escapes the workspace')
  })
})
