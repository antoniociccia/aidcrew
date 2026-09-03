import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { attach, mentions } from './mentions.ts'

let repo: string

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-mentions-')))
  mkdirSync(join(repo, 'src'), { recursive: true })
  writeFileSync(join(repo, 'src', 'auth.ts'), 'export const rotate = () => {}\n')
  writeFileSync(join(repo, 'README.md'), '# hello\n')
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

describe('finding what a message names', () => {
  test('picks out a path written with @', () => {
    expect(mentions('look at @src/auth.ts please')).toEqual(['src/auth.ts'])
  })

  test('takes several, in the order they were written', () => {
    expect(mentions('@src/auth.ts and @README.md')).toEqual(['src/auth.ts', 'README.md'])
  })

  test('does not treat the end of a sentence as part of the name', () => {
    // Attaching nothing because somebody wrote a full stop would be maddening.
    expect(mentions('start with @src/auth.ts.')).toEqual(['src/auth.ts'])
    expect(mentions('either @a.ts, @b.ts or neither')).toEqual(['a.ts', 'b.ts'])
  })

  test('accepts a quoted path, which is how one with a space is written', () => {
    // The finder offers `docs/my plan.md`; unquoted, the mention stopped at
    // the space and the message went out saying "could not read docs/my".
    expect(mentions('look at @"docs/my plan.md" first')).toEqual(['docs/my plan.md'])
  })

  test('leaves an email address alone', () => {
    // `@` in the middle of a word is not a mention; it is an address, a
    // decorator, a scoped package.
    expect(mentions('write to someone@example.com')).toEqual([])
    expect(mentions('install @aidcrew/core')).toEqual(['aidcrew/core'])
  })

  test('says each file once, however many times it is named', () => {
    expect(mentions('@a.ts then @a.ts again')).toEqual(['a.ts'])
  })
})

describe('attaching what a message names', () => {
  test('puts the file after the message, not before it', async () => {
    const result = await attach('what does @src/auth.ts do?', repo)

    // What you asked is the point. A model that meets four files before the
    // question reads the question as being about the last of them.
    expect(result.text.indexOf('what does')).toBeLessThan(result.text.indexOf('export const'))
    expect(result.text).toContain('<file path="src/auth.ts">')
    expect(result.attached).toHaveLength(1)
  })

  test('leaves the message alone when it names nothing', async () => {
    const result = await attach('fix the auth bug', repo)

    expect(result.text).toBe('fix the auth bug')
    expect(result.attached).toEqual([])
  })

  test('names what it could not find rather than failing', async () => {
    // A typo in a filename should cost a sentence, not a turn.
    const result = await attach('look at @src/ghost.ts', repo)

    expect(result.missing).toEqual(['src/ghost.ts'])
    expect(result.text).toBe('look at @src/ghost.ts')
  })

  test('refuses to reach outside the workspace', async () => {
    const result = await attach('read @../../etc/passwd', repo)

    expect(result.attached).toEqual([])
    expect(result.missing).toEqual(['../../etc/passwd'])
  })

  test('truncates a file too big to send, and says it did', async () => {
    writeFileSync(join(repo, 'huge.txt'), 'x'.repeat(200_000))

    const result = await attach('@huge.txt', repo)

    expect(result.attached[0]?.truncated).toBe(true)
    expect(result.text).toContain('truncated')
    expect(result.text.length).toBeLessThan(120_000)
  })

  test('stops at ten files, however many are named', async () => {
    for (let at = 0; at < 15; at += 1) writeFileSync(join(repo, `f${at}.txt`), 'x')
    const named = Array.from({ length: 15 }, (_, at) => `@f${at}.txt`).join(' ')

    expect((await attach(named, repo)).attached).toHaveLength(10)
  })
})
