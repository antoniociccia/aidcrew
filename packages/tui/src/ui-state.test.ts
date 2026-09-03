import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { EMPTY, inOrder, pathOf, readUiState, writeUiState } from './ui-state.ts'

let cwd: string

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-ui-')))
})

afterEach(() => rmSync(cwd, { recursive: true, force: true }))

function write(body: string): void {
  mkdirSync(dirname(pathOf(cwd)), { recursive: true })
  writeFileSync(pathOf(cwd), body)
}

describe('remembering how the interface was left', () => {
  test('reads back what was written', () => {
    const state = {
      split: ['coder', 'reviewer'],
      weights: { coder: 2 },
      target: 'coder',
      reasoning: true,
      task: 'main',
      unleashed: [],
      order: ['coder', 'architect'],
    }
    writeUiState(cwd, state)

    expect(readUiState(cwd)).toEqual(state)
  })

  test('opens at the defaults when there is nothing saved', () => {
    expect(readUiState(cwd)).toEqual(EMPTY)
  })

  test('keeps it in the project, next to the worktrees', () => {
    expect(pathOf(cwd)).toBe(join(cwd, '.aidcrew', 'ui.json'))
  })
})

describe('when the file has been damaged', () => {
  test('is not stopped by something that is not JSON', () => {
    write('{ not json')

    expect(readUiState(cwd)).toEqual(EMPTY)
  })

  test('is not stopped by JSON of the wrong shape', () => {
    write('"a string"')

    expect(readUiState(cwd)).toEqual(EMPTY)
  })

  test('drops entries in the split that are not names', () => {
    write(JSON.stringify({ split: ['coder', 7, null, 'reviewer'] }))

    expect(readUiState(cwd).split).toEqual(['coder', 'reviewer'])
  })

  test('drops a weight that would divide the screen into nothing', () => {
    write(JSON.stringify({ weights: { a: 2, b: 0, c: -1, d: 'wide', e: Number.NaN } }))

    expect(readUiState(cwd).weights).toEqual({ a: 2 })
  })

  test('treats a target that is not a name as no target', () => {
    write(JSON.stringify({ target: { id: 'coder' } }))

    expect(readUiState(cwd).target).toBe('')
  })
})

describe('when it cannot be written', () => {
  test('carries on rather than failing the session', () => {
    expect(() => writeUiState('/proc/nowhere/at/all', EMPTY)).not.toThrow()
  })
})

describe('what a task leaves behind', () => {
  test('remembers which job was being worked in', () => {
    // A worktree outlives the session that made it, which makes a task a
    // small project: reopening in the wrong one is a way to do an
    // afternoon's work in a directory nobody meant.
    writeUiState(cwd, { ...EMPTY, task: 'auth' })

    expect(readUiState(cwd).task).toBe('auth')
  })

  test('remembers which agents were acting without being asked', () => {
    // Forgetting means an agent you deliberately turned loose starts asking
    // again; writing it to the project config would make a decision taken for
    // one afternoon permanent. Here it is per project and per person.
    writeUiState(cwd, { ...EMPTY, unleashed: ['coder', 'auth/coder'] })

    expect(readUiState(cwd).unleashed).toEqual(['coder', 'auth/coder'])
    // And a session with nobody loose says so, rather than saying nothing.
    writeUiState(cwd, EMPTY)
    expect(readUiState(cwd).unleashed).toEqual([])
  })

  test('a file written before tasks existed opens on the main one', () => {
    mkdirSync(dirname(pathOf(cwd)), { recursive: true })
    writeFileSync(pathOf(cwd), JSON.stringify({ split: [], target: 'coder' }))

    expect(readUiState(cwd).task).toBe('main')
    expect(readUiState(cwd).unleashed).toEqual([])
  })
})

describe('the order the tabs were left in', () => {
  const team = [{ id: 'architect' }, { id: 'coder' }, { id: 'reviewer' }]

  test('is applied when there is one', () => {
    expect(inOrder(team, ['reviewer', 'architect', 'coder']).map((one) => one.id)).toEqual([
      'reviewer',
      'architect',
      'coder',
    ])
  })

  test('puts somebody new on the end rather than nowhere', () => {
    // A remembered order is a list of names and the team changes. Somebody
    // added since is not in it, and dropping them would make adding an agent
    // look like it did nothing.
    expect(inOrder(team, ['reviewer', 'architect']).map((one) => one.id)).toEqual([
      'reviewer',
      'architect',
      'coder',
    ])
  })

  test('ignores a name that has left the team', () => {
    expect(inOrder(team, ['gone', 'coder']).map((one) => one.id)).toEqual([
      'coder',
      'architect',
      'reviewer',
    ])
  })

  test('leaves the team alone when nothing was remembered', () => {
    expect(inOrder(team, [])).toBe(team)
  })
})
