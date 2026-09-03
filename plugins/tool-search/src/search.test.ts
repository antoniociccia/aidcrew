import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { globTool, grepTool } from './search.ts'

let root: string

function make(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-search-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = async (tool: typeof grepTool | typeof globTool, input: object) =>
  (await tool.execute(input, { cwd: root, agentId: 'test', signal: new AbortController().signal }))
    .content

describe('grep', () => {
  test('finds a pattern and says where, so the next read is a read and not a hunt', async () => {
    make({ 'src/auth.ts': 'const token = 1\nrotate(token)\n', 'src/other.ts': 'nothing here\n' })

    const found = await run(grepTool, { pattern: 'rotate' })

    expect(found).toContain('src/auth.ts:2')
    expect(found).toContain('rotate(token)')
    expect(found).not.toContain('other.ts')
  })

  test('takes a regular expression, which is the reason to have it', async () => {
    make({ 'a.ts': 'function one() {}\nfunction two() {}\nconst three = 3\n' })

    const found = await run(grepTool, { pattern: '^function (one|two)' })

    expect(found).toContain('a.ts:1')
    expect(found).toContain('a.ts:2')
    expect(found).not.toContain('a.ts:3')
  })

  test('searches only where asked when given a glob', async () => {
    make({ 'src/a.ts': 'needle\n', 'docs/b.md': 'needle\n' })

    const found = await run(grepTool, { pattern: 'needle', include: '**/*.md' })

    expect(found).toContain('docs/b.md')
    expect(found).not.toContain('src/a.ts')
  })

  test('shows the lines around a match when asked', async () => {
    // A match on its own is a line to go and read; with a line either side
    // it is usually an answer.
    make({ 'src/a.ts': 'one\ntwo\nthree\nfour\nfive\n' })

    const found = await run(grepTool, { pattern: 'three', context: 1 })

    expect(found).toContain('src/a.ts:2- two')
    expect(found).toContain('src/a.ts:3: three')
    expect(found).toContain('src/a.ts:4- four')
    expect(found).not.toContain('one')
  })

  test('separates groups of context and never repeats a line', async () => {
    make({ 'src/a.ts': 'a\nb\nX\nX\nc\nd\ne\nf\nX\ng\n' })

    const found = await run(grepTool, { pattern: 'X', context: 1 })

    const lines = found.split('\n')
    expect(lines.filter((line) => line === '--')).toHaveLength(1)
    expect(lines.filter((line) => line.includes(':4:'))).toHaveLength(1)
  })

  test('says so plainly when there is nothing, rather than returning nothing', async () => {
    make({ 'a.ts': 'hello\n' })

    // An empty result and a broken tool look identical to a model, and it
    // will try again differently instead of believing the answer.
    expect(await run(grepTool, { pattern: 'goodbye' })).toContain('no matches')
  })

  test('skips what nobody means to search', async () => {
    make({
      'node_modules/pkg/index.js': 'needle\n',
      '.git/COMMIT_EDITMSG': 'needle\n',
      'dist/bundle.js': 'needle\n',
      'src/real.ts': 'needle\n',
    })

    const found = await run(grepTool, { pattern: 'needle' })

    expect(found).toContain('src/real.ts')
    expect(found).not.toContain('node_modules')
    expect(found).not.toContain('.git')
    expect(found).not.toContain('dist')
  })

  test('leaves binary files alone', async () => {
    const root = make({ 'src/a.ts': 'needle\n' })
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x00, 0x6e, 0x65]))

    const found = await run(grepTool, { pattern: 'ne' })

    expect(found).not.toContain('logo.png')
  })

  test('stops at a limit and says it stopped', async () => {
    const lines = Array.from({ length: 400 }, (_, at) => `needle ${at}`).join('\n')
    make({ 'big.ts': lines })

    const found = await run(grepTool, { pattern: 'needle', limit: 10 })

    expect(found.split('\n').filter((line) => line.includes('needle')).length).toBe(10)
    expect(found).toContain('more')
  })

  test('refuses a pattern that is not a regular expression', async () => {
    make({ 'a.ts': 'x\n' })

    expect(await run(grepTool, { pattern: '([' })).toContain('not a valid')
  })

  test('never leaves the workspace, however the path is written', async () => {
    make({ 'a.ts': 'x\n' })

    expect(await run(grepTool, { pattern: 'x', path: '../..' })).toContain('escapes the workspace')
  })

  test('refuses an include glob that reaches outside the workspace', async () => {
    // Only `path` went through the workspace check; the include glob was handed
    // to Bun.Glob untouched. So `../secret/*` and an absolute glob each read a
    // file the agent was never given. An include that is absolute or climbs
    // with `..` is refused before a single file is opened, and reads nothing.
    const workspace = make({ 'a.ts': 'nothing here\n' })
    const secret = join(workspace, '..', 'aidcrew-search-secret.txt')
    writeFileSync(secret, 'AWS_SECRET=hunter2\n')

    try {
      for (const include of ['../aidcrew-search-secret.txt', secret]) {
        const refused = await run(grepTool, { pattern: 'SECRET', include })
        expect(refused).toContain('workspace')
        expect(refused).not.toContain('hunter2')
      }
    } finally {
      rmSync(secret, { force: true })
    }
  })
})

describe('glob', () => {
  test('lists the files matching a pattern, newest first', async () => {
    make({ 'src/a.ts': '', 'src/b.ts': '', 'README.md': '' })

    const found = await run(globTool, { pattern: '**/*.ts' })

    expect(found).toContain('src/a.ts')
    expect(found).toContain('src/b.ts')
    expect(found).not.toContain('README.md')
  })

  test('skips the directories nobody means to list', async () => {
    make({ 'node_modules/pkg/a.ts': '', 'src/a.ts': '' })

    expect(await run(globTool, { pattern: '**/*.ts' })).not.toContain('node_modules')
  })

  test('says so when nothing matches', async () => {
    make({ 'a.ts': '' })

    expect(await run(globTool, { pattern: '**/*.rs' })).toContain('no files')
  })

  test('stays inside the workspace', async () => {
    make({ 'a.ts': '' })

    expect(await run(globTool, { pattern: '**/*', path: '/etc' })).toContain(
      'escapes the workspace',
    )
  })

  test('refuses a glob pattern that reaches outside the workspace', async () => {
    // The pattern went straight to Bun.Glob, so `../secret/**` and an absolute
    // pattern each listed files outside the workspace. A pattern that is
    // absolute or climbs with `..` is refused, both vectors, before scanning.
    const workspace = make({ 'a.ts': '' })
    const secret = join(workspace, '..', 'aidcrew-glob-secret.txt')
    writeFileSync(secret, 'x\n')

    try {
      for (const pattern of ['../aidcrew-glob-secret.txt', join(workspace, '..', '*')]) {
        expect(await run(globTool, { pattern })).toContain('workspace')
      }
    } finally {
      rmSync(secret, { force: true })
    }
  })
})
