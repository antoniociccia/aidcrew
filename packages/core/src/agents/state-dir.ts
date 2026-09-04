import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** Where a project keeps everything of aidcrew's, config and state alike. */
export const STATE_DIR = '.aidcrew'

/**
 * What in `.aidcrew/` is the runtime's and never the project's.
 *
 * The config and the agent files beside these are the point of committing
 * the directory; these are checkouts, snapshots of files before an agent
 * changed them, the layout of the screen, and a database of every transcript
 * line. Committed by accident they are a guaranteed merge conflict, and a way
 * for the contents of a private file an agent read to end up in a public
 * repository.
 */
const RUNTIME_STATE = ['history.db*', 'ui.json', 'wt/', 'undo/']

/**
 * Keeps the runtime state out of git, without anyone deciding to.
 *
 * Called by everything that creates `.aidcrew/` or writes state into it, so
 * the ignore file exists from the first moment there is something to ignore.
 * A fresh project used to get none, and its first `git add .aidcrew` took
 * eleven undo snapshots along with the team.
 *
 * Written once and never touched again: somebody who has edited it has
 * decided something, and this is not the place to argue.
 */
export function keepStateOutOfGit(root: string): void {
  const directory = join(root, STATE_DIR)
  mkdirSync(directory, { recursive: true })

  const path = join(directory, '.gitignore')
  if (existsSync(path)) return

  writeFileSync(
    path,
    [
      '# Written by aidcrew. Runtime state, not project configuration.',
      '# The config and the agents next to this file are meant to be committed.',
      ...RUNTIME_STATE,
      '',
    ].join('\n'),
  )
}
