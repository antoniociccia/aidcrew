import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { repositoryBehind } from '@aidcrew/tool-fs'

/**
 * Keeping the previous version of every file an agent changes.
 *
 * This is what "non-destructive" actually means. Refusing writes is not it:
 * an agent that cannot write cannot work, and a guard that blocks the task
 * gets turned off within the hour. What makes a change safe is that it can be
 * taken back — so every write and every edit puts the old bytes somewhere
 * first, and `undo` puts them back.
 *
 * Agents work in git worktrees, which already cover tracked files. This covers
 * what git does not: a file that was never committed, a project that is not a
 * repository, and the case where you want one change back rather than all of
 * them.
 */

export type Change = {
  /** Relative to the workspace, so the record survives being moved. */
  path: string
  /** Where the previous bytes are, or absent when the file was created. */
  kept?: string
  at: number
  agentId: string
}

export const UNDO_DIR = join('.aidcrew', 'undo')

const JOURNAL = 'changes.jsonl'

/**
 * Where the journal and the kept bytes live, for work done in `cwd`.
 *
 * An agent's cwd is its worktree, under `<repo>/.aidcrew/wt/<task>`. Keeping
 * the snapshots there made them untracked files in the checkout — every
 * `git status` was dirty, and the task's diff listed them as new files — and
 * `aidcrew undo`, run in the repository as the README says to, looked in the
 * repository and found nothing. So they live with the repository, which is
 * where the person is; only a directory in no repository keeps its own.
 */
export function undoRoot(cwd: string): string {
  return repositoryBehind(cwd) ?? cwd
}

/** A copy taken, but not yet recorded: the write it was taken for has not happened. */
export type Snapshot = { root: string; change: Change }

/**
 * Puts the current contents somewhere safe, before the tool writes over them.
 *
 * Nothing is recorded yet. Whether there is a change to record is only known
 * once the tool has run — see `commit` and `discard` — and recording it here
 * meant an edit that failed, which changed nothing, was still the newest
 * entry, and the next undo put back a file that had not moved.
 *
 * A file that does not exist yet is recorded with nothing kept: undoing a
 * creation means deleting it, and pretending there was an empty file before
 * would leave one behind.
 */
export function snapshot(cwd: string, path: string, agentId: string, now: number): Snapshot {
  const root = undoRoot(cwd)
  const full = resolve(cwd, path)
  const where = join(root, UNDO_DIR)
  mkdirSync(where, { recursive: true })

  const change: Change = {
    path: relative(root, full),
    at: now,
    agentId,
  }

  if (existsSync(full)) {
    // Named by when and by what: two agents changing the same file in the same
    // millisecond is unlikely, and the name still has to be theirs.
    const name = `${now}-${agentId}-${change.path.replace(/[^\w.-]/g, '_')}`
    copyFileSync(full, join(where, name))
    change.kept = name
  }

  return { root, change }
}

/** Records the change: the tool wrote, so there is something to take back. */
export function commit(taken: Snapshot): void {
  appendChange(join(taken.root, UNDO_DIR), taken.change)
}

/** Forgets the change: the tool failed, and the file is as it was. */
export function discard(taken: Snapshot): void {
  if (taken.change.kept === undefined) return
  rmSync(join(taken.root, UNDO_DIR, taken.change.kept), { force: true })
}

/** `snapshot` and `commit` in one, for a change that is known to have happened. */
export function keep(cwd: string, path: string, agentId: string, now: number): void {
  commit(snapshot(cwd, path, agentId, now))
}

/** Everything that has been changed, oldest first. `workspace` is an `undoRoot`. */
export function changes(workspace: string): Change[] {
  const path = join(workspace, UNDO_DIR, JOURNAL)
  if (!existsSync(path)) return []

  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as Change]
      } catch {
        // One damaged line should not cost the rest of the history.
        return []
      }
    })
}

/**
 * Puts back the most recent change, and says what it did.
 *
 * One at a time on purpose: undoing everything at once is a second
 * irreversible act, and the thing you usually want back is the last one.
 */
export function undo(
  workspace: string,
): { path: string; what: 'restored' | 'removed' } | undefined {
  const all = changes(workspace)
  const last = all.pop()
  if (!last) return undefined

  const full = within(workspace, last.path)
  const kept = last.kept === undefined ? undefined : within(join(workspace, UNDO_DIR), last.kept)

  // The journal is an ordinary file inside the workspace, so the agent whose
  // changes it records can also write it. Undo then runs later, on the
  // human's word, with the human's reach — which is when a line naming
  // `../../.zshrc` stops being the agent's business and becomes the machine's.
  // A line that points anywhere else is dropped, not obeyed.
  if (full === undefined || (last.kept !== undefined && kept === undefined)) {
    rewrite(workspace, all)
    return undefined
  }

  if (kept === undefined) {
    // It did not exist before, so putting it back means taking it away. Moved
    // aside rather than deleted: undoing an undo should still be possible.
    if (existsSync(full)) {
      renameSync(
        full,
        join(workspace, UNDO_DIR, `${last.at}-removed-${last.path.replace(/[^\w.-]/g, '_')}`),
      )
    }
    rewrite(workspace, all)
    return { path: last.path, what: 'removed' }
  }

  mkdirSync(dirname(full), { recursive: true })
  copyFileSync(kept, full)
  rewrite(workspace, all)
  return { path: last.path, what: 'restored' }
}

/**
 * The path a journal entry names, or nothing when it names somewhere else.
 *
 * Containment is decided with `relative()` rather than `startsWith()` so a
 * sibling sharing the root's prefix — `/repo-other` against `/repo` — is
 * outside, and the root is resolved first so a workspace reached through a
 * link still compares against itself.
 */
function within(root: string, path: string): string | undefined {
  const real = existsSync(root) ? realpathSync(root) : resolve(root)
  const full = resolve(real, path)
  const rel = relative(real, full)

  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return undefined
  return full
}

function appendChange(where: string, change: Change): void {
  const path = join(where, JOURNAL)
  const line = `${JSON.stringify(change)}\n`
  writeFileSync(path, existsSync(path) ? readFileSync(path, 'utf8') + line : line)
}

function rewrite(workspace: string, all: Change[]): void {
  const path = join(workspace, UNDO_DIR, JOURNAL)
  writeFileSync(path, all.map((change) => `${JSON.stringify(change)}\n`).join(''))
}
