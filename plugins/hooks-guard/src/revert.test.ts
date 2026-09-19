import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { revertable, revertHunk } from './revert.ts'
import { keep, UNDO_DIR } from './undo.ts'
import { fileOf, taskOf } from './worktree.ts'

let workspace: string
let file: string

beforeEach(() => {
  workspace = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-revert-')))
  file = join(workspace, 'a.ts')
})

afterEach(() => rmSync(workspace, { recursive: true, force: true }))

/** A change made the way the guard records one: the old bytes, then the write. */
function changed(before: string, after: string, agentId = 'coder', at = 1): void {
  if (before === '') rmSync(file, { force: true })
  else writeFileSync(file, before)
  keep(workspace, 'a.ts', agentId, at)
  writeFileSync(file, after)
}

describe('listing what can be taken back', () => {
  test('gives the hunks of each change, newest first', () => {
    changed('one\ntwo\n', 'one\nTWO\n', 'coder', 1)
    changed('one\nTWO\n', 'ONE\nTWO\n', 'architect', 2)

    const all = revertable(workspace)

    expect(all.map((one) => one.agentId)).toEqual(['architect', 'coder'])
    expect(all[0]?.hunks).toHaveLength(1)
    expect(all[0]?.path).toBe('a.ts')
  })

  test('drops a journal line naming somewhere outside the workspace', () => {
    // The journal is written inside the agent's own checkout, so the agent can
    // write it. Undo runs later, on a person's word, with a person's reach.
    changed('one\n', 'ONE\n')
    appendFileSync(
      join(workspace, UNDO_DIR, 'changes.jsonl'),
      `${JSON.stringify({ path: '../../.zshrc', at: 9, agentId: 'coder' })}\n`,
    )

    expect(revertable(workspace).some((one) => one.path.includes('.zshrc'))).toBe(false)
  })

  test('says nothing is revertable when the change has already been taken back', () => {
    changed('one\n', 'ONE\n')
    writeFileSync(file, 'one\n')

    expect(revertable(workspace)).toEqual([])
  })
})

describe('taking one hunk back', () => {
  test('restores exactly the bytes that were there', () => {
    changed('one\ntwo\nthree\n', 'one\nTWO\nthree\n')

    const outcome = revertHunk(workspace, 0, 0)

    expect(outcome).toMatchObject({ ok: true, path: 'a.ts' })
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\nthree\n')
  })

  test('refuses when it would quietly discard what was written afterwards', () => {
    // The hunks are worked out from the kept bytes against the file as it
    // stands, so this cannot fail on a stale offset — it fails on meaning.
    // Putting the first change back would take the second one with it, and
    // doing that without saying so is the one outcome worse than refusing.
    changed('one\ntwo\n', 'one\nTWO\n', 'coder', 1)
    changed('one\nTWO\n', 'one\nTHREE\n', 'coder', 2)

    expect(revertHunk(workspace, 0, 0)).toEqual({ ok: false, because: 'later', later: 1 })
    expect(readFileSync(file, 'utf8')).toBe('one\nTHREE\n')
  })

  test('does it anyway when told to, which is what the screen asks about', () => {
    changed('one\ntwo\n', 'one\nTWO\n', 'coder', 1)
    changed('one\nTWO\n', 'one\nTHREE\n', 'coder', 2)

    expect(revertHunk(workspace, 0, 0, { anyway: true })).toMatchObject({ ok: true })
    expect(readFileSync(file, 'utf8')).toBe('one\ntwo\n')
  })

  test('the newest change is not held back by changes to other files', () => {
    changed('one\ntwo\n', 'one\nTWO\n', 'coder', 1)
    writeFileSync(join(workspace, 'b.ts'), 'other\n')
    keep(workspace, 'b.ts', 'coder', 2)
    writeFileSync(join(workspace, 'b.ts'), 'OTHER\n')

    expect(revertHunk(workspace, 0, 0)).toMatchObject({ ok: true })
  })

  test('leaves the other hunks of the same change alone', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'l'].join('\n')
    const after = ['A', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j', 'k', 'L'].join('\n')
    changed(`${before}\n`, `${after}\n`)

    const outcome = revertHunk(workspace, 0, 0)

    expect(outcome).toMatchObject({ ok: true })
    const text = readFileSync(file, 'utf8')
    expect(text.startsWith('a\n')).toBe(true)
    expect(text.trimEnd().endsWith('L')).toBe(true)
  })

  test('says which lines it put back, so the agent can be told', () => {
    changed('one\ntwo\nthree\n', 'one\nTWO\nthree\n')

    const outcome = revertHunk(workspace, 0, 0)

    expect(outcome).toMatchObject({ ok: true, lines: [1, 3] })
  })

  test('takes away a file that only ever existed because of this change', () => {
    changed('', 'invented\n')

    expect(revertHunk(workspace, 0, 0)).toMatchObject({ ok: true })
    expect(existsSync(file)).toBe(false)
  })

  test('says so when the file has gone', () => {
    changed('one\n', 'ONE\n')
    rmSync(file)

    expect(revertHunk(workspace, 0, 0)).toEqual({ ok: false, because: 'gone' })
  })

  test('a hunk that is not there is not an exception', () => {
    changed('one\n', 'ONE\n')

    expect(revertHunk(workspace, 0, 7)).toEqual({ ok: false, because: 'gone' })
  })
})

describe('a path inside a worktree', () => {
  test('is named by the file, not by where the agent was working', () => {
    expect(fileOf('.aidcrew/wt/rates/src/rates.ts')).toBe('src/rates.ts')
    expect(taskOf('.aidcrew/wt/rates/src/rates.ts')).toBe('rates')
  })

  test('is left alone when the agent shares the repository', () => {
    expect(fileOf('src/rates.ts')).toBe('src/rates.ts')
    expect(taskOf('src/rates.ts')).toBeUndefined()
  })

  test('survives the separators Windows uses', () => {
    expect(fileOf('.aidcrew\\wt\\rates\\src\\rates.ts')).toBe('src/rates.ts')
  })
})

describe('a change inside a worktree', () => {
  test('is listed under the file it changed', () => {
    mkdirSync(join(workspace, '.aidcrew', 'wt', 'rates', 'src'), { recursive: true })
    const inside = join(workspace, '.aidcrew', 'wt', 'rates', 'src', 'rates.ts')
    writeFileSync(inside, 'one\n')
    keep(workspace, join('.aidcrew', 'wt', 'rates', 'src', 'rates.ts'), 'coder', 1)
    writeFileSync(inside, 'ONE\n')

    const [change] = revertable(workspace)

    expect(change?.file).toBe('src/rates.ts')
    expect(change?.task).toBe('rates')
  })
})
