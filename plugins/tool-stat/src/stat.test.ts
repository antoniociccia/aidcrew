import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ago, countEntries, formatSize, statTool } from './stat.ts'

let root: string

function make(files: Record<string, string | Buffer>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-stat-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

const execute = (input: object) =>
  statTool.execute(input, { cwd: root, agentId: 'test', signal: new AbortController().signal })
const run = async (input: object) => (await execute(input)).content

describe('stat', () => {
  test('sizes a text file, counts its lines, and says when it changed', async () => {
    make({ 'notes.md': 'one\ntwo\nthree\n' })

    const shown = await run({ path: 'notes.md' })

    expect(shown).toStartWith('notes.md: text')
    expect(shown).toContain('14 bytes')
    expect(shown).toContain('3 lines')
    expect(shown).toContain('changed just now')
    expect(shown).toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z/)
  })

  test('counts a last line that has no newline after it', async () => {
    make({ 'a.txt': 'one\ntwo' })

    expect(await run({ path: 'a.txt' })).toContain('2 lines')
  })

  test('calls a file with a NUL byte binary and does not count its lines', async () => {
    make({ 'logo.png': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x0a, 0x1a]) })

    const shown = await run({ path: 'logo.png' })

    expect(shown).toContain('binary')
    expect(shown).not.toContain('lines')
  })

  test('calls a file that is not UTF-8 binary, NUL or no NUL', async () => {
    make({ 'legacy.dat': Buffer.from([0x68, 0x69, 0xff, 0xfe, 0x0a]) })

    expect(await run({ path: 'legacy.dat' })).toContain('binary')
  })

  test('is not fooled by a multibyte character straddling the sniffed window', async () => {
    // 8,191 bytes of ASCII put the two-byte 'é' across the 8 KB boundary.
    make({ 'accents.txt': `${'a'.repeat(8_191)}é\nmore text\n` })

    expect(await run({ path: 'accents.txt' })).toContain('text')
  })

  test('says a file is empty rather than counting zero lines of it', async () => {
    make({ 'empty.ts': '' })

    const shown = await run({ path: 'empty.ts' })

    expect(shown).toContain('empty')
    expect(shown).not.toContain('lines')
  })

  test('shows a large size in units a person reads, next to the exact bytes', async () => {
    make({ 'big.json': `${'x'.repeat(200_000)}\n` })

    const shown = await run({ path: 'big.json' })

    expect(shown).toContain('200,001 bytes')
    expect(shown).toContain('195 KB')
  })

  test('describes a directory by what it holds, skipping what nobody means', async () => {
    make({
      'src/a.ts': '',
      'src/b.ts': '',
      'src/lib/c.ts': '',
      'README.md': '',
      'node_modules/pkg/index.js': '',
      '.git/HEAD': '',
      'dist/out.js': '',
      '.aidcrew/wt/main/huge.ts': '',
    })

    const shown = await run({ path: '.' })

    expect(shown).toContain('directory')
    expect(shown).toContain('4 files')
    expect(shown).toContain('2 directories')
    expect(shown).toContain('node_modules')
  })

  test('stops counting a directory at a bound and says it did', async () => {
    const files: Record<string, string> = {}
    for (let at = 0; at < 30; at += 1) files[`f${at}.ts`] = ''
    make(files)

    const counted = await countEntries(root, 10)

    expect(counted.files + counted.directories).toBe(10)
    expect(counted.stopped).toBe(true)
  })

  test('says when the path does not exist', async () => {
    make({})

    const result = await execute({ path: 'nowhere.txt' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('nowhere.txt')
  })

  test('never leaves the workspace, however the path is written', async () => {
    make({ 'a.txt': 'x\n' })

    expect(await run({ path: '../../etc/passwd' })).toContain('escapes the workspace')
    expect(await run({ path: '/etc' })).toContain('escapes the workspace')
  })

  test('reports an old change as old', async () => {
    make({ 'old.txt': 'x\n' })
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000)
    utimesSync(join(root, 'old.txt'), threeDaysAgo, threeDaysAgo)

    expect(await run({ path: 'old.txt' })).toContain('changed 3 days ago')
  })
})

describe('ago', () => {
  const minute = 60_000
  const hour = 60 * minute
  const day = 24 * hour

  test.each([
    [10_000, 'just now'],
    [90_000, '1 minute ago'],
    [5 * minute, '5 minutes ago'],
    [hour, '1 hour ago'],
    [23 * hour, '23 hours ago'],
    [day, '1 day ago'],
    [29 * day, '29 days ago'],
    [45 * day, '1 month ago'],
    [400 * day, '1 year ago'],
    [-5_000, 'just now'],
  ])('%d ms → %s', (elapsed, expected) => {
    expect(ago(elapsed)).toBe(expected)
  })
})

describe('formatSize', () => {
  test.each([
    [0, '0 bytes'],
    [1, '1 byte'],
    [999, '999 bytes'],
    [1_536, '1,536 bytes (1.5 KB)'],
    [200_001, '200,001 bytes (195 KB)'],
    [3_500_000, '3,500,000 bytes (3.3 MB)'],
    [2_147_483_648, '2,147,483,648 bytes (2.0 GB)'],
  ])('%d → %s', (bytes, expected) => {
    expect(formatSize(bytes)).toBe(expected)
  })
})
