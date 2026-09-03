import { existsSync, readdirSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { journalPath, orphanedRecords } from './journal.ts'
import type { SettingsStore } from './store.ts'

/**
 * What a project leaves behind when it is deleted, taken away.
 *
 * Two things and one fact. Every `trust` writes a record keyed by the
 * directory it was given in, and every session writes a transcript in a
 * folder of its own, and nothing has ever removed either — so a week of trying
 * things in temporary directories leaves a store full of permissions for paths
 * that do not exist and a home directory full of transcripts for projects that
 * do not either.
 *
 * The transcripts are the reason to care rather than the tidiness: they hold
 * tool output and the contents of files that were read, so a record for a
 * project you deleted is a copy of that project sitting in your home
 * indefinitely.
 *
 * Gone rather than unused, throughout. A project you have not opened in a year
 * is still one you trusted, and forgetting that on your behalf would mean
 * asking you again for a decision you already made.
 */

export type ForgetIo = {
  write(text: string): void
  writeError(text: string): void
}

/** Keys written against a workspace, whichever kind of permission they are. */
const AGAINST_A_WORKSPACE = ['plugin.trust.', 'mcp.trust.', 'project.trust.']

export async function runForget(
  store: SettingsStore,
  io: ForgetIo,
  home: string,
  /**
   * One project to start over, rather than every project that is gone.
   *
   * `aidcrew forget .` — the transcript of the project you are standing in,
   * and nothing else. What was trusted stays, because this forgets what was
   * said and not what was decided.
   */
  only?: string,
): Promise<number> {
  if (only !== undefined) return startOver(io, home, only)

  const records = orphanedRecords(home)
  const gone = new Set(records.map((one) => one.cwd))

  // A permission is stale when the directory it names is gone, which is the
  // same question the records answer — so they answer it for both, and a key
  // whose workspace is not among them is left alone rather than guessed at.
  const keys = store
    .list()
    .map((one) => one.key)
    .filter((key) => [...gone].some((where) => givenIn(key, where)))

  const unreadable = countUnreadable(home, records.length)

  if (records.length === 0 && keys.length === 0) {
    io.write('nothing to forget: every project you have opened is still where it was.\n')
    if (unreadable > 0) io.write(older(unreadable))
    return 0
  }

  for (const record of records) {
    rmSync(join(home, '.aidcrew', 'projects', record.slug), { recursive: true, force: true })
  }
  for (const key of keys) store.unset(key)

  io.write(
    `forgot ${records.length} ${records.length === 1 ? 'project' : 'projects'} that are no ` +
      `longer on disk: ${records.length === 1 ? 'its' : 'their'} transcript` +
      `${records.length === 1 ? '' : 's'} and ${keys.length} permission` +
      `${keys.length === 1 ? '' : 's'} given in ${records.length === 1 ? 'it' : 'them'}.\n`,
  )
  if (unreadable > 0) io.write(older(unreadable))
  return 0
}

/**
 * Whether a key was written against this workspace, and not one like it.
 *
 * The whole `<prefix><workspace>.` and not a substring: deleting `/x/app`
 * used to take the permissions of `/x/app2` with it, since `/x/app` appears
 * in every key of every project whose name begins the same way.
 */
function givenIn(key: string, workspace: string): boolean {
  return AGAINST_A_WORKSPACE.some((prefix) => key.startsWith(`${prefix}${workspace}.`))
}

/** Records written before the path was kept beside them. */
function countUnreadable(home: string, known: number): number {
  try {
    return Math.max(0, readdirSync(join(home, '.aidcrew', 'projects')).length - known)
  } catch {
    return 0
  }
}

function older(count: number): string {
  return (
    `${count} older record${count === 1 ? '' : 's'} say nothing about where they came from and ` +
    'were left alone: the folder name cannot be read back, and deleting a transcript on a ' +
    'guess is worse than keeping one.\n'
  )
}

/** Takes one project's transcript, leaving the project and its trust alone. */
function startOver(io: ForgetIo, home: string, cwd: string): number {
  const record = dirname(journalPath(cwd, home))
  if (!existsSync(record)) {
    io.write('nothing to forget: this project has no transcript yet.\n')
    return 0
  }

  rmSync(record, { recursive: true, force: true })
  io.write(
    'forgot what was said in this project. What it was trusted with stays: this ' +
      'forgets the conversation, not the decisions.\n',
  )
  return 0
}
