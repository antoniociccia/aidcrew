import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { forConfig, isDirectory, list } from './browse.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-browse-')))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('listing a directory', () => {
  test('offers the way back first', () => {
    expect(list(root)[0]).toMatchObject({ name: '..', up: true })
  })

  test('lists directories and not files', () => {
    mkdirSync(join(root, 'skills'))
    writeFileSync(join(root, 'README.md'), '')

    expect(list(root).map((entry) => entry.name)).toEqual(['..', 'skills'])
  })

  test('sorts them, so the same directory always reads the same way', () => {
    for (const name of ['zebra', 'alpha', 'middle']) mkdirSync(join(root, name))

    expect(list(root).map((entry) => entry.name)).toEqual(['..', 'alpha', 'middle', 'zebra'])
  })

  test('hides dot directories, except the two that hold what we are looking for', () => {
    for (const name of ['.git', '.cache', '.claude', '.aidcrew']) mkdirSync(join(root, name))

    expect(list(root).map((entry) => entry.name)).toEqual(['..', '.aidcrew', '.claude'])
  })

  test('offers only the way back from a directory it cannot read', () => {
    // A dead end in the middle of a picker is worse than an empty one.
    expect(list(join(root, 'does-not-exist'))).toHaveLength(1)
  })

  test('has no way back from the root of the filesystem', () => {
    expect(list('/').every((entry) => entry.up !== true)).toBe(true)
  })
})

describe('writing a path into the project config', () => {
  const cwd = '/repo'
  const home = '/home/someone'

  test('writes a path inside the project relative to it', () => {
    expect(forConfig('/repo/.claude/skills', cwd, home)).toBe('./.claude/skills')
  })

  test('writes the project itself as a dot', () => {
    expect(forConfig('/repo', cwd, home)).toBe('.')
  })

  test('writes a path in the home directory with a tilde', () => {
    expect(forConfig('/home/someone/.claude/agents', cwd, home)).toBe('~/.claude/agents')
  })

  test('leaves anything else absolute rather than guessing', () => {
    expect(forConfig('/opt/shared/skills', cwd, home)).toBe('/opt/shared/skills')
  })

  test('is not fooled by a sibling whose name starts the same', () => {
    // `/repo-old` is not inside `/repo`, however much the strings agree.
    expect(forConfig('/repo-old/skills', cwd, home)).toBe('/repo-old/skills')
  })
})

describe('deciding whether a path can be opened', () => {
  test('says yes to a directory', () => {
    // `Bun.file()` answers false for every directory there has ever been,
    // which is how the screen for opening a project came to refuse all of
    // them — including the one it was standing in.
    expect(isDirectory(root)).toBe(true)
  })

  test('says no to a file and to nothing at all', () => {
    writeFileSync(join(root, 'a.txt'), 'x')

    expect(isDirectory(join(root, 'a.txt'))).toBe(false)
    expect(isDirectory(join(root, 'nowhere'))).toBe(false)
  })
})
