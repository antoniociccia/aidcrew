import { describe, expect, test } from 'bun:test'
import { tmpdir } from 'node:os'
import { leavesWorkspace } from './escape.ts'

const checkout = '/repos/app/.aidcrew/wt/main'

describe('a command that would leave the checkout', () => {
  // Watched on a real run: a coder in its own worktree ran
  // `cd /repos/app && git switch -c work/thing`, which moved the person's
  // own checkout — the repository root — onto a branch of the coder's, and
  // left the harness counting the job's commits in the wrong place. Every
  // file tool refuses a path outside the workspace; the shell has to as well,
  // at the one place a shell changes where it is.
  test('is named when it changes directory to somewhere outside', () => {
    expect(leavesWorkspace('cd /repos/app && git switch -c work/thing', checkout)).toBe(
      '/repos/app',
    )
    expect(leavesWorkspace('pushd /repos/app', checkout)).toBe('/repos/app')
    expect(leavesWorkspace('cd ../../.. && ls', checkout)).toBe('/repos/app')
  })

  test('is named when git is pointed at another checkout', () => {
    expect(leavesWorkspace('git -C /repos/app merge work/main', checkout)).toBe('/repos/app')
    expect(leavesWorkspace('git -C ../../.. status', checkout)).toBe('/repos/app')
  })

  test('is not named for moving about inside the checkout', () => {
    expect(leavesWorkspace('cd src && bun test', checkout)).toBeUndefined()
    expect(leavesWorkspace(`cd ${checkout}/src`, checkout)).toBeUndefined()
    expect(leavesWorkspace('cd ./packages/core; ls', checkout)).toBeUndefined()
    expect(leavesWorkspace('git -C src log', checkout)).toBeUndefined()
  })

  test('lets a command go to the temporary directory, which is scratch', () => {
    expect(leavesWorkspace('cd /tmp && ls', checkout)).toBeUndefined()
    expect(leavesWorkspace(`cd ${tmpdir()}/x`, checkout)).toBeUndefined()
  })

  test('still names climbing out of a checkout that itself lives under the temporary directory', () => {
    // Every test repository does, and so does many a throwaway project.
    const under = `${tmpdir()}/repo/.aidcrew/wt/main`

    expect(leavesWorkspace(`cd ${tmpdir()}/repo && git switch main`, under)).toBe(
      `${tmpdir()}/repo`,
    )
    expect(leavesWorkspace(`cd ${tmpdir()}/elsewhere`, under)).toBeUndefined()
  })

  test('is not fooled by a path that merely starts the same way', () => {
    expect(leavesWorkspace('cd /repos/app/.aidcrew/wt/main-other', checkout)).toBe(
      '/repos/app/.aidcrew/wt/main-other',
    )
  })

  test('ignores a cd inside a string or with no target', () => {
    expect(leavesWorkspace('echo "cd /repos/app"', checkout)).toBeUndefined()
    expect(leavesWorkspace('cd', checkout)).toBeUndefined()
  })
})
