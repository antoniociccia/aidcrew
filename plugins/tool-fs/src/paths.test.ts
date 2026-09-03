import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  explainMissing,
  MissingWorkspaceError,
  repositoryBehind,
  resolveInWorkspace,
  WorkspaceBoundaryError,
} from './paths.ts'

// realpath because macOS resolves /tmp through a symlink, which is exactly the
// class of thing this module exists to handle.
const root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-paths-')))
const outside = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-outside-')))

mkdirSync(join(root, 'src'))
writeFileSync(join(root, 'src', 'a.ts'), 'x')
writeFileSync(join(outside, 'secret.txt'), 'shh')
symlinkSync(outside, join(root, 'escape'))
symlinkSync(join(outside, 'secret.txt'), join(root, 'src', 'linked.txt'))
// Dangling on purpose: nothing exists at either end yet.
symlinkSync(join(outside, 'pending.txt'), join(root, 'src', 'pending.txt'))
symlinkSync(join(root, 'src', 'a.ts'), join(root, 'src', 'inside.txt'))
symlinkSync(join(root, 'src', 'loop.txt'), join(root, 'src', 'loop.txt'))

afterAll(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(outside, { recursive: true, force: true })
})

describe('resolveInWorkspace', () => {
  test('resolves a relative path against the workspace root', () => {
    expect(resolveInWorkspace(root, 'src/a.ts')).toBe(join(root, 'src', 'a.ts'))
  })

  test('accepts an absolute path that is already inside the workspace', () => {
    expect(resolveInWorkspace(root, join(root, 'src/a.ts'))).toBe(join(root, 'src', 'a.ts'))
  })

  test('resolves a path for a file that does not exist yet', () => {
    expect(resolveInWorkspace(root, 'src/new/deep.ts')).toBe(join(root, 'src', 'new', 'deep.ts'))
  })

  test('rejects a path that climbs out with ..', () => {
    expect(() => resolveInWorkspace(root, '../secret.txt')).toThrow(WorkspaceBoundaryError)
  })

  test('rejects an absolute path outside the workspace', () => {
    expect(() => resolveInWorkspace(root, '/etc/passwd')).toThrow(WorkspaceBoundaryError)
  })

  test('rejects a path that leaves through a symlinked directory', () => {
    expect(() => resolveInWorkspace(root, 'escape/secret.txt')).toThrow(WorkspaceBoundaryError)
  })

  test('rejects a symlinked file that points outside', () => {
    expect(() => resolveInWorkspace(root, 'src/linked.txt')).toThrow(WorkspaceBoundaryError)
  })

  // A link whose target does not exist is the interesting case: realpath
  // cannot resolve one, so walking up to the nearest existing ancestor lands
  // back inside the workspace and calls it contained. Writing through it still
  // creates the file where the link points.
  test('rejects a symlink that points outside at a file that is not there yet', () => {
    expect(() => resolveInWorkspace(root, 'src/pending.txt')).toThrow(WorkspaceBoundaryError)
  })

  test('rejects a path under a symlinked directory that is not there yet', () => {
    expect(() => resolveInWorkspace(root, 'escape/new/deep.txt')).toThrow(WorkspaceBoundaryError)
  })

  test('resolves a link that stays inside the workspace', () => {
    expect(resolveInWorkspace(root, 'src/inside.txt')).toBe(join(root, 'src', 'a.ts'))
  })

  test('gives up on a link that points at itself rather than following it', () => {
    expect(resolveInWorkspace(root, 'src/loop.txt')).toBeString()
  })

  test('rejects a path that only looks like a sibling of the root', () => {
    // `${root}-evil` shares the root's string prefix but is a different tree,
    // so a naive startsWith check would let it through.
    expect(() => resolveInWorkspace(root, `${root}-evil/x.ts`)).toThrow(WorkspaceBoundaryError)
  })

  test('names the offending path in the error', () => {
    expect(() => resolveInWorkspace(root, '/etc/passwd')).toThrow(/etc\/passwd/)
  })
})

describe('a file missing from a worktree', () => {
  let repo: string

  beforeEach(() => {
    repo = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-wt-')))
    mkdirSync(join(repo, '.aidcrew', 'wt', 'coder'), { recursive: true })
  })

  afterEach(() => rmSync(repo, { recursive: true, force: true }))

  test('says it was probably never committed, when it is in the repository', () => {
    // "No such file" is true and useless: the file is right there on the
    // person's screen. A worktree is a checkout and only sees what was
    // committed, which is the thing worth saying.
    writeFileSync(join(repo, 'BRIEF.md'), '# five tools')

    const because = explainMissing(join(repo, '.aidcrew', 'wt', 'coder'), 'BRIEF.md')

    expect(because).toMatch(/not been committed/)
  })

  test('says nothing when the file is not in the repository either', () => {
    // Then it really is missing, and the ordinary error is the right one.
    expect(explainMissing(join(repo, '.aidcrew', 'wt', 'coder'), 'ghost.md')).toBeUndefined()
  })

  test('says nothing for an agent that is not in a worktree at all', () => {
    writeFileSync(join(repo, 'BRIEF.md'), '# five tools')

    expect(explainMissing(repo, 'BRIEF.md')).toBeUndefined()
  })

  test('finds the repository a worktree belongs to', () => {
    expect(repositoryBehind(join(repo, '.aidcrew', 'wt', 'coder'))).toBe(repo)
    expect(repositoryBehind('/somewhere/else')).toBeUndefined()
  })
})

/**
 * A checkout that is no longer there.
 *
 * An agent works in a git worktree, and a worktree can go while the agent is
 * still holding it: somebody prunes it, a run beside this one removes it, a
 * cleanup script tidies. Every file tool then throws `ENOENT ... lstat
 * '<path>/.aidcrew/wt/main'`, which names a path the model has never seen and
 * suggests nothing — so it tries again, and again. Observed: an agent spent
 * its whole turn alternating `glob *` and `wc .` against a directory that had
 * stopped existing, because nothing it was told distinguished "that file is
 * missing" from "everything is missing".
 */
describe('when the workspace itself is gone', () => {
  test('says so, rather than reporting the path it tried to stat', () => {
    expect(() => resolveInWorkspace('/nowhere/at/all', 'src/a.ts')).toThrow(MissingWorkspaceError)
  })

  test('names the directory and says trying again will not help', () => {
    try {
      resolveInWorkspace('/nowhere/at/all', 'src/a.ts')
      throw new Error('it should have refused')
    } catch (error) {
      const message = error instanceof Error ? error.message : ''
      expect(message).toContain('/nowhere/at/all')
      expect(message).toMatch(/gone|no longer|removed/i)
    }
  })

  test('is not the same as a file that is missing inside one that is there', () => {
    // The distinction the raw error destroyed: one is worth another look, the
    // other is worth stopping.
    expect(resolveInWorkspace(root, 'src/not-here.ts')).toBe(join(root, 'src', 'not-here.ts'))
  })
})
