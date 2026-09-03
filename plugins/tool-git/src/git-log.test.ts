import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { gitLogTool } from './git-log.ts'

let root: string

function make(): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-git-log-'))
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Runs git in the fixture, with an identity so commits do not depend on the machine. */
function git(...args: string[]): string {
  const result = Bun.spawnSync(['git', ...args], {
    cwd: root,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Ada Lovelace',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada Lovelace',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
      GIT_AUTHOR_DATE: '2026-01-02T03:04:05+00:00',
      GIT_COMMITTER_DATE: '2026-01-02T03:04:05+00:00',
    },
  })
  if (result.exitCode !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr.toString()}`)
  return result.stdout.toString()
}

function repository(): void {
  make()
  git('init', '-q', '-b', 'main')
}

function commit(path: string, body: string, subject: string): void {
  const full = join(root, path)
  mkdirSync(join(full, '..'), { recursive: true })
  writeFileSync(full, body)
  git('add', path)
  git('commit', '-q', '-m', subject)
}

const run = async (input: object) =>
  await gitLogTool.execute(input, {
    cwd: root,
    agentId: 'test',
    signal: new AbortController().signal,
  })

describe('git-log', () => {
  test('lists the commits touching a path: short hash, ISO date, author, subject', async () => {
    repository()
    commit('src/a.ts', 'one', 'feat: add a')
    commit('src/b.ts', 'other', 'feat: add b')
    commit('src/a.ts', 'two', 'fix: a again')

    const { content } = await run({ path: 'src/a.ts' })

    // The offset is written either way — `+00:00` up to git 2.39 and `Z` from
    // 2.47 — and both are the same instant in strict ISO 8601. Pinning one of
    // them pins the git on the machine that wrote the test: this passed for
    // months here and failed on the first run against a newer one.
    const UTC = String.raw`2026-01-02T03:04:05(?:Z|\+00:00)`
    const lines = content.split('\n')
    expect(lines.length).toBe(2)
    expect(lines[0]).toMatch(new RegExp(`^[0-9a-f]{7,} {2}${UTC} {2}Ada Lovelace {2}fix: a again$`))
    expect(lines[1]).toMatch(new RegExp(`^[0-9a-f]{7,} {2}${UTC} {2}Ada Lovelace {2}feat: add a$`))
    expect(content).not.toContain('add b')
  })

  test('covers the whole repository when given no path', async () => {
    repository()
    commit('a.ts', '', 'feat: a')
    commit('b.ts', '', 'feat: b')

    const { content } = await run({})

    expect(content).toContain('feat: a')
    expect(content).toContain('feat: b')
  })

  test('keeps a subject with unusual characters on one line, in one piece', async () => {
    // The fields are split on a delimiter a subject cannot contain, not on
    // whitespace or punctuation a subject often does.
    repository()
    commit('a.ts', '', 'fix: handle "quotes", | pipes, tabs\tand : colons')

    const { content } = await run({})

    expect(content.split('\n').length).toBe(1)
    expect(content).toContain('fix: handle "quotes", | pipes, tabs\tand : colons')
  })

  test('returns ten by default, up to fifty when asked, and says when there are more', async () => {
    repository()
    for (let at = 0; at < 12; at += 1) commit('a.ts', String(at), `feat: change ${at}`)

    const some = await run({ path: 'a.ts' })
    expect(some.content.split('\n').filter((line) => line.includes('feat:')).length).toBe(10)
    expect(some.content).toContain('more')

    const all = await run({ path: 'a.ts', count: 50 })
    expect(all.content.split('\n').filter((line) => line.includes('feat:')).length).toBe(12)
    expect(all.content).not.toContain('more')

    const tooMany = await run({ path: 'a.ts', count: 51 })
    expect(tooMany.isError).toBe(true)
  })

  test('says so when no commit touches the path', async () => {
    repository()
    commit('a.ts', '', 'feat: a')
    writeFileSync(join(root, 'new.ts'), '')

    const { content, isError } = await run({ path: 'new.ts' })

    expect(content).toContain('no commits touch new.ts')
    expect(isError).toBeUndefined()
  })

  test('says so when the repository has no commits yet', async () => {
    repository()

    const { content, isError } = await run({})

    expect(content).toContain('no commits yet')
    expect(isError).toBeUndefined()
  })

  test('says so when the workspace is not a repository', async () => {
    make()
    writeFileSync(join(root, 'a.ts'), '')

    const { content, isError } = await run({ path: 'a.ts' })

    expect(isError).toBe(true)
    expect(content).toContain('not inside a git repository')
  })

  test('never leaves the workspace', async () => {
    repository()

    expect((await run({ path: '../../etc' })).content).toContain('escapes the workspace')
  })
})
