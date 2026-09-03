import { join } from 'node:path'

/**
 * The jobs a repository has open, read from git rather than remembered.
 *
 * A worktree outlives the session that made it: a terminal closed with work in
 * it leaves that work on disk, and the next session has no idea it exists
 * unless it looks. Asking git is the only answer that is true after a crash,
 * after a reboot, and after somebody removed one by hand.
 */

export type Task = {
  /** The name it was started under, which is the directory it lives in. */
  name: string
  path: string
  /** Where its checkout stands, so a stale one can be told from a busy one. */
  head: string
  /** Files changed and not committed. The measure of whether work is in it. */
  changed: number
  /** Commits it is behind the repository. */
  behind: number
  /** True for the repository itself, which is a task without being a worktree. */
  main: boolean
}

export type RunGit = (args: string[], cwd?: string) => Promise<string>

/** Where worktrees live: inside the project, out of the way and gitignored. */
export const WORKTREE_ROOT = join('.aidcrew', 'wt')

/**
 * Every task this repository has, including the repository itself.
 *
 * The main checkout is listed as a task because it is one: working there is a
 * legitimate choice, and leaving it out of the list would make it the option
 * nobody can see.
 */
export async function readTasks(root: string, git: RunGit): Promise<Task[]> {
  const listed = await git(['worktree', 'list', '--porcelain'])
  const head = (await git(['rev-parse', 'HEAD'])).trim()

  const tasks: Task[] = []
  const marker = `${WORKTREE_ROOT}/`

  for (const block of listed.split('\n\n')) {
    const path = /^worktree (.+)$/m.exec(block)?.[1]
    if (path === undefined) continue

    const at = /^HEAD ([0-9a-f]+)$/m.exec(block)?.[1] ?? ''
    const repository = path === root
    // A worktree somebody else made, in some other directory, is theirs: this
    // lists the jobs of this program, plus the repository.
    if (!repository && !path.replace(/\\/g, '/').includes(marker)) continue

    const name = repository ? MAIN : (path.split(/[/\\]/).pop() ?? path)
    const task: Task = {
      name,
      path,
      head: at,
      changed: await countChanges(path, git),
      behind: repository || at === '' || at === head ? 0 : await countBehind(at, git),
      main: name === MAIN,
    }

    // The main job's own checkout is the repository's row, not a second row
    // under it with the same name. Agents on the main job work in
    // `.aidcrew/wt/main`, and that checkout outlives the session, so it is
    // where the work is — and listed on its own it was the row that said
    // nothing about being the repository.
    const twin = tasks.find((one) => one.name === name)
    if (twin) {
      twin.changed += task.changed
      twin.behind = Math.max(twin.behind, task.behind)
      if (!repository) {
        twin.path = task.path
        twin.head = task.head
      }
      continue
    }
    tasks.push(task)
  }

  // The repository first, then the rest by name: the one you are in is the one
  // you are most often looking for.
  return tasks.sort((a, b) => Number(b.main) - Number(a.main) || a.name.localeCompare(b.name))
}

/** The job everything without a task of its own is on, and the repository's name in the list. */
const MAIN = 'main'

async function countChanges(path: string, git: RunGit): Promise<number> {
  const status = await git(['status', '--porcelain'], path)
  return status.trim() === '' ? 0 : status.trim().split('\n').length
}

async function countBehind(at: string, git: RunGit): Promise<number> {
  const count = await git(['rev-list', '--count', `${at}..HEAD`])
  return Number.parseInt(count.trim(), 10) || 0
}

/**
 * What a task is worth saying about it, in one line.
 *
 * The two numbers answer the two questions somebody choosing has: is there
 * work in here already, and is what I would be working from still current.
 */
export function describeTask(task: Task): string {
  const parts: string[] = []
  if (task.changed > 0) parts.push(`${task.changed} changed`)
  if (task.behind > 0) parts.push(`${task.behind} behind`)
  if (parts.length === 0) parts.push(task.main ? 'the repository itself' : 'clean')
  return parts.join(', ')
}
