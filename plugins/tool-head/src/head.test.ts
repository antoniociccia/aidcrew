import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CHUNK, countLines, headTool, lastLines, openSource, type Source } from './head.ts'

let root: string

function make(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-head-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

const execute = (input: object) =>
  headTool.execute(input, { cwd: root, agentId: 'test', signal: new AbortController().signal })
const run = async (input: object) => (await execute(input)).content

const numbered = (count: number, from = 1) =>
  Array.from({ length: count }, (_, at) => `line ${from + at}`).join('\n')

/** A source that remembers how much was asked of it. */
function counting(source: Source): Source & { bytesRead: number; largestRead: number } {
  const wrapped = {
    bytesRead: 0,
    largestRead: 0,
    size: source.size,
    close: () => source.close(),
    async read(start: number, end: number) {
      const bytes = await source.read(start, end)
      wrapped.bytesRead += bytes.length
      wrapped.largestRead = Math.max(wrapped.largestRead, bytes.length)
      return bytes
    },
  }
  return wrapped
}

describe('head', () => {
  test('shows the first twenty lines, numbered, and says how many it did not show', async () => {
    make({ 'a.txt': `${numbered(100)}\n` })

    const shown = await run({ path: 'a.txt' })

    expect(shown).toContain('1\tline 1')
    expect(shown).toContain('20\tline 20')
    expect(shown).not.toContain('line 21')
    expect(shown).toContain('80 more lines')
    expect(shown).toContain('100 in total')
  })

  test('shows the end when asked, with the real line numbers and how many came before', async () => {
    make({ 'a.txt': `${numbered(100)}\n` })

    const shown = await run({ path: 'a.txt', from: 'end', lines: 3 })

    expect(shown).toContain('98\tline 98')
    expect(shown).toContain('100\tline 100')
    expect(shown).not.toContain('line 97')
    expect(shown).toContain('97 lines before')
    expect(shown).toContain('100 in total')
  })

  test('returns a short file whole and does not pretend it was cut', async () => {
    make({ 'a.txt': `${numbered(5)}\n` })

    for (const from of ['start', 'end']) {
      const shown = await run({ path: 'a.txt', from })
      expect(shown).toContain('1\tline 1')
      expect(shown).toContain('5\tline 5')
      expect(shown).toContain('whole file')
      expect(shown).not.toContain('more')
      expect(shown).not.toContain('before')
    }
  })

  test('counts a last line with no newline after it, at both ends', async () => {
    make({ 'a.txt': numbered(30) })

    expect(await run({ path: 'a.txt', from: 'end', lines: 2 })).toContain('30\tline 30')
    expect(await run({ path: 'a.txt', lines: 2 })).toContain('30 in total')
  })

  test('does not turn a blank line at the end into a phantom line', async () => {
    make({ 'a.txt': 'one\ntwo\n\n' })

    const shown = await run({ path: 'a.txt', from: 'end', lines: 1 })

    expect(shown).toContain('3\t')
    expect(shown).toContain('3 in total')
  })

  test('says so when the file is empty', async () => {
    make({ 'a.txt': '' })

    expect(await run({ path: 'a.txt' })).toContain('empty')
  })

  test('strips a carriage return, which is not part of the line', async () => {
    make({ 'a.txt': 'one\r\ntwo\r\n' })

    expect(await run({ path: 'a.txt', from: 'end', lines: 1 })).toBe(
      '... 1 line before this (2 in total)\n2\ttwo',
    )
  })

  test('reads the end of a fifty-thousand-line file without reading the file', async () => {
    const body = `${Array.from({ length: 50_000 }, (_, at) => `line ${at + 1} of fifty thousand`).join('\n')}\n`
    make({ 'big.log': body })
    const size = Buffer.byteLength(body)
    expect(size).toBeGreaterThan(1_000_000)

    const shown = await run({ path: 'big.log', from: 'end' })
    expect(shown).toContain('49981\tline 49981 of fifty thousand')
    expect(shown).toContain('50000\tline 50000 of fifty thousand')
    expect(shown).not.toContain('line 49980 ')
    expect(shown).toContain('49980 lines before')
    expect(shown).toContain('50000 in total')

    // The tail is found by reading backwards from the end, and stops as soon
    // as it has enough line breaks, so it touches a sliver of the file.
    const tail = counting(await openSource(join(root, 'big.log')))
    try {
      const found = await lastLines(tail, 20)
      expect(found.lines.at(-1)).toBe('line 50000 of fifty thousand')
      expect(found.lines.length).toBe(20)
      expect(tail.bytesRead).toBeLessThan(size / 20)
      expect(tail.bytesRead).toBeLessThanOrEqual(CHUNK)
    } finally {
      await tail.close()
    }

    // The total is counted by streaming: every byte passes, but never more
    // than one chunk of them is in memory at a time.
    const whole = counting(await openSource(join(root, 'big.log')))
    try {
      expect(await countLines(whole)).toBe(50_000)
      expect(whole.largestRead).toBeLessThanOrEqual(CHUNK)
    } finally {
      await whole.close()
    }
  })

  test('gives up on a file whose lines are longer than it will hold, and says so', async () => {
    make({ 'one-line.min.js': `${'x'.repeat(3_000_000)}\n` })

    const result = await execute({ path: 'one-line.min.js', from: 'end', lines: 5 })

    expect(result.isError).toBeUndefined()
    expect(result.content).toContain('1 in total')
    expect(result.content).toContain('longer')
  })

  test('refuses a binary file rather than printing it', async () => {
    make({})
    writeFileSync(join(root, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a]))

    const result = await execute({ path: 'logo.png' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('binary')
  })

  test('refuses a directory, naming the tool that lists one', async () => {
    make({ 'src/a.ts': '' })

    const result = await execute({ path: 'src' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('directory')
    expect(result.content).toContain('tree')
  })

  test('says when the file does not exist', async () => {
    make({})

    const result = await execute({ path: 'nowhere.txt' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('nowhere.txt')
  })

  test('never leaves the workspace, however the path is written', async () => {
    make({ 'a.txt': 'x\n' })

    expect(await run({ path: '../../etc/passwd' })).toContain('escapes the workspace')
    expect(await run({ path: '/etc/passwd' })).toContain('escapes the workspace')
  })
})
