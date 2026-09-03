import { changes, undo, undoRoot } from '@aidcrew/hooks-guard'

/**
 * Taking back what an agent changed.
 *
 * The counterpart to letting an agent write at all: a change that can be
 * reversed does not have to be prevented, and a guard that prevents the task
 * gets turned off within the hour. One at a time, newest first, because
 * undoing everything at once is a second irreversible act.
 */

export type UndoIo = {
  write(text: string): void
  writeError(text: string): void
}

export async function runUndo(rest: string[], io: UndoIo, cwd: string): Promise<number> {
  // The journal lives with the repository, even for a change an agent made in
  // its worktree under it. Read from there, this finds the same one whether
  // it is run in the repository or from inside the worktree.
  const root = undoRoot(cwd)
  const all = changes(root)

  if (rest.includes('--list')) {
    if (all.length === 0) {
      io.write('nothing to take back\n')
      return 0
    }

    // Newest first: what you are looking for is nearly always the last thing.
    for (const change of [...all].reverse()) {
      const what = change.kept === undefined ? 'created' : 'changed'
      io.write(`  ${change.agentId.padEnd(12)} ${what.padEnd(8)} ${change.path}\n`)
    }
    return 0
  }

  const done = undo(root)
  if (!done) {
    io.writeError('nothing to take back\n')
    return 1
  }

  io.write(
    done.what === 'removed'
      ? `removed ${done.path}, which did not exist before\n`
      : `restored ${done.path}\n`,
  )
  return 0
}
