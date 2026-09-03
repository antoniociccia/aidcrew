import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { treeTool } from './tree.ts'

let root: string

function make(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-tree-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = async (input: object) =>
  (
    await treeTool.execute(input, {
      cwd: root,
      agentId: 'test',
      signal: new AbortController().signal,
    })
  ).content

describe('tree', () => {
  test('shows directories first, then files, each group sorted, indented by depth', async () => {
    make({ 'zeta.ts': '', 'alpha.ts': '', 'src/b.ts': '', 'src/a.ts': '', 'docs/x.md': '' })

    const shown = await run({})

    expect(shown.split('\n').slice(0, 7)).toEqual([
      './',
      '  docs/',
      '    x.md',
      '  src/',
      '    a.ts',
      '    b.ts',
      '  alpha.ts',
    ])
    expect(shown).toContain('  zeta.ts')
  })

  test('stops at the depth asked for, default two, and says how big a cut-off directory is', async () => {
    make({ 'a/b/c/d.ts': '', 'a/b/e.ts': '', 'a/f.ts': '' })

    const shown = await run({})

    expect(shown).toContain('    b/ (2 entries)')
    expect(shown).not.toContain('c/')
    expect(shown).not.toContain('d.ts')

    expect(await run({ depth: 3 })).toContain('      c/ (1 entry)')
  })

  test('starts from the path given and names it', async () => {
    make({ 'packages/core/src/index.ts': '', 'packages/core/package.json': '', 'other.ts': '' })

    const shown = await run({ path: 'packages/core' })

    expect(shown.split('\n')[0]).toBe('packages/core/')
    expect(shown).toContain('  src/')
    expect(shown).toContain('  package.json')
    expect(shown).not.toContain('other.ts')
  })

  test('never shows node_modules, .git, dist or .aidcrew, even with no .gitignore', async () => {
    make({
      'node_modules/pkg/index.js': '',
      '.git/HEAD': '',
      'dist/bundle.js': '',
      '.aidcrew/config.toml': '',
      'src/real.ts': '',
    })

    const shown = await run({})

    expect(shown).toContain('src/')
    for (const hidden of ['node_modules', '.git', 'dist', '.aidcrew', 'bundle.js']) {
      expect(shown).not.toContain(hidden)
    }
  })

  test('skips what the root .gitignore skips, the way git reads it', async () => {
    make({
      '.gitignore': [
        '*.log',
        '!keep.log',
        '/build',
        'coverage/',
        '# a comment',
        '',
        'secret?.txt',
        'docs/**/*.tmp',
      ].join('\n'),
      'app.log': '',
      'keep.log': '',
      'build/out.js': '',
      'src/build/keep.js': '',
      'coverage/lcov.info': '',
      'src/coverage': '',
      'secret1.txt': '',
      'secret.txt': '',
      'docs/a/b.tmp': '',
      'docs/a/b.md': '',
    })

    const shown = await run({ depth: 4 })

    expect(shown).not.toContain('app.log')
    expect(shown).toContain('keep.log')
    expect(shown).not.toContain('out.js')
    expect(shown).toContain('keep.js')
    expect(shown).not.toContain('lcov.info')
    expect(shown).toContain('    coverage')
    expect(shown).not.toContain('secret1.txt')
    expect(shown).toContain('secret.txt')
    expect(shown).not.toContain('b.tmp')
    expect(shown).toContain('b.md')
    expect(shown).toContain('.gitignore')
  })

  test('reads a nested .gitignore for the directory it sits in', async () => {
    make({
      'sub/.gitignore': 'tmp/\n',
      'sub/tmp/x.ts': '',
      'sub/keep.ts': '',
      'tmp/y.ts': '',
    })

    const shown = await run({ depth: 3 })

    expect(shown).not.toContain('x.ts')
    expect(shown).toContain('keep.ts')
    expect(shown).toContain('y.ts')
  })

  test('caps the entries it shows and says how many it did not', async () => {
    const files: Record<string, string> = {}
    for (let at = 0; at < 30; at += 1) files[`f${String(at).padStart(2, '0')}.ts`] = ''
    make(files)

    const shown = await run({ limit: 10 })

    expect(shown.split('\n').filter((line) => line.endsWith('.ts')).length).toBe(10)
    expect(shown).toContain('20 more')
    expect(shown).toContain('not shown')
  })

  test('spends the cap breadth first, so every top-level entry is seen before any deep one', async () => {
    const files: Record<string, string> = {}
    for (let at = 0; at < 8; at += 1) files[`aaa/deep${at}.ts`] = ''
    files['bbb/one.ts'] = ''
    files['zzz.ts'] = ''
    make(files)

    const shown = await run({ limit: 5 })

    expect(shown).toContain('  aaa/')
    expect(shown).toContain('  bbb/')
    expect(shown).toContain('  zzz.ts')
  })

  test('counts what it showed', async () => {
    make({ 'src/a.ts': '', 'src/b.ts': '', 'README.md': '' })

    expect(await run({})).toContain('1 directory, 3 files')
  })

  test('says so when a directory is empty', async () => {
    make({})
    mkdirSync(join(root, 'empty'))

    expect(await run({ path: 'empty' })).toContain('empty')
  })

  test('shows a symlink for what it is and does not follow it', async () => {
    make({ 'real/a.ts': '' })
    symlinkSync(join(root, 'real'), join(root, 'link'))

    const shown = await run({ depth: 3 })

    expect(shown).toContain('link -> ')
    expect(shown.split('\n').filter((line) => line.includes('a.ts')).length).toBe(1)
  })

  test('refuses a file, saying what it is, rather than listing nothing', async () => {
    make({ 'a.ts': '' })

    const result = await treeTool.execute(
      { path: 'a.ts' },
      { cwd: root, agentId: 'test', signal: new AbortController().signal },
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('a file')
  })

  test('says when the path does not exist', async () => {
    make({})

    const result = await treeTool.execute(
      { path: 'nowhere' },
      { cwd: root, agentId: 'test', signal: new AbortController().signal },
    )

    expect(result.isError).toBe(true)
    expect(result.content).toContain('nowhere')
    expect(result.content).toContain('does not exist')
  })

  test('never leaves the workspace, however the path is written', async () => {
    make({ 'a.ts': '' })

    for (const path of ['..', '../..', '/etc']) {
      expect(await run({ path })).toContain('escapes the workspace')
    }
  })
})
