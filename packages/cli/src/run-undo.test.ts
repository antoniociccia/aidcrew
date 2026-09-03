import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { keep } from '@aidcrew/hooks-guard'
import { runUndo } from './run-undo.ts'

let repo: string
let out: string[]
let errors: string[]

const io = () => ({
  write: (text: string) => out.push(text),
  writeError: (text: string) => errors.push(text),
})

beforeEach(() => {
  repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-undo-')))
  out = []
  errors = []
})

afterEach(() => rmSync(repo, { recursive: true, force: true }))

/**
 * What the guard does around an agent's write, with the agent where the
 * harness puts it: in a worktree of its own under the repository.
 */
function changedInWorktree(): string {
  const worktree = join(repo, '.aidcrew', 'wt', 'task-1')
  mkdirSync(worktree, { recursive: true })
  writeFileSync(join(worktree, 'a.txt'), 'one\n')
  keep(worktree, 'a.txt', 'coder', 1)
  writeFileSync(join(worktree, 'a.txt'), 'two\n')
  return worktree
}

describe('taking back the last change any agent made', () => {
  test('takes back a change made in a worktree when run from the repository', async () => {
    // The README says `aidcrew undo` takes back the last change any agent
    // made, and the person runs it where they are: in the repository. The
    // journal used to sit in the worktree, so from the repository there was
    // nothing to take back, however much the agents had done.
    const worktree = changedInWorktree()

    expect(await runUndo([], io(), repo)).toBe(0)

    expect(out).toEqual(['restored .aidcrew/wt/task-1/a.txt\n'])
    expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('one\n')
  })

  test('finds the same journal from inside the worktree', async () => {
    const worktree = changedInWorktree()

    expect(await runUndo([], io(), worktree)).toBe(0)

    expect(readFileSync(join(worktree, 'a.txt'), 'utf8')).toBe('one\n')
  })

  test('lists what there is to take back, newest first', async () => {
    changedInWorktree()

    expect(await runUndo(['--list'], io(), repo)).toBe(0)

    expect(out[0]).toContain('coder')
    expect(out[0]).toContain('.aidcrew/wt/task-1/a.txt')
  })

  test('says so when there is nothing to take back', async () => {
    expect(await runUndo([], io(), repo)).toBe(1)

    expect(errors).toEqual(['nothing to take back\n'])
  })
})
