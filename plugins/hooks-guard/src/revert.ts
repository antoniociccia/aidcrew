import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { changeOf, type Hunk, linesOf } from '@aidcrew/tool-fs'
import { changes, UNDO_DIR, within } from './undo.ts'
import { fileOf, taskOf } from './worktree.ts'

/**
 * Taking back one part of one change, while the agent carries on.
 *
 * Stopping an agent to disagree with a line it wrote costs the rest of its
 * turn, and undoing everything costs the work that was fine. This is the
 * third answer: the hunk goes back to what it was, the agent is told, and
 * nothing else stops.
 *
 * Nothing new is stored for it. The guard already keeps the previous bytes of
 * every change; what a hunk is, is worked out from those bytes against the
 * file as it stands, every time it is asked. So the list is never stale — a
 * change the agent has itself reverted simply stops appearing.
 */

export type Revertable = {
  /** Where the change is in the journal, which is how it is named later. */
  at: number
  /** As journaled: relative to the workspace, checkout and all. */
  path: string
  /** The file itself, for a person to read. */
  file: string
  /** The job whose checkout it was changed in, when it was one. */
  task?: string
  agentId: string
  when: number
  hunks: Hunk[]
}

export type Reverted =
  | { ok: true; path: string; lines: [number, number]; removed: boolean }
  | { ok: false; because: 'gone' | 'outside' }
  /** How many changes to the same file came after this one. */
  | { ok: false; because: 'later'; later: number }

/**
 * Every change that is still a change, newest first.
 *
 * Newest first because that is the order somebody looks in: the line you just
 * watched appear is the one you want back.
 */
export function revertable(workspace: string): Revertable[] {
  return changes(workspace)
    .flatMap((change, at): Revertable[] => {
      const found = read(workspace, change.path, change.kept)
      if (found === undefined) return []

      const diff = changeOf(fileOf(change.path), found.before, found.now)
      if (diff === undefined) return []

      const task = taskOf(change.path)
      return [
        {
          at,
          path: change.path,
          file: fileOf(change.path),
          ...(task === undefined ? {} : { task }),
          agentId: change.agentId,
          when: change.at,
          hunks: diff.hunks,
        },
      ]
    })
    .reverse()
}

/**
 * Puts one hunk of one change back, or says why it did not.
 *
 * There is no stale-offset failure to worry about: a hunk is worked out from
 * the kept bytes against the file as it stands, at the moment it is asked
 * for, so it always describes the file that is actually there.
 *
 * What there is to worry about is meaning. Taking back a change that has been
 * written over takes the writing with it, and doing that quietly is the one
 * outcome worse than refusing — so it is refused, counted, and left to
 * whoever is watching to say `anyway`.
 */
export function revertHunk(
  workspace: string,
  at: number,
  hunk: number,
  { anyway = false }: { anyway?: boolean } = {},
): Reverted {
  const all = changes(workspace)
  const change = all[at]
  if (change === undefined) return { ok: false, because: 'gone' }

  const later = all.filter((one, index) => index > at && one.path === change.path).length
  if (later > 0 && !anyway) return { ok: false, because: 'later', later }

  const full = within(workspace, change.path)
  if (full === undefined) return { ok: false, because: 'outside' }

  const found = read(workspace, change.path, change.kept)
  if (found === undefined) return { ok: false, because: 'gone' }

  const diff = changeOf(fileOf(change.path), found.before, found.now)
  const part = diff?.hunks[hunk]
  if (part === undefined) return { ok: false, because: 'gone' }

  const lines = linesOf(found.now)
  const from = Math.max(0, part.newStart - 1)

  // A hunk with nothing on the new side emptied the file: context is taken
  // from both edges of a change, so a hunk without any is a change with no
  // file left around it. There is nothing to splice into — it is filled back
  // in whole.
  if (part.newLines.length === 0) {
    writeFileSync(full, text(part.oldLines, found.now))
    return { ok: true, path: fileOf(change.path), lines: [1, part.oldLines.length], removed: false }
  }

  // The hunk was worked out from this very text a line ago, so the lines it
  // names are the lines that are there. That is the whole reason the hunks
  // are never cached: an anchor that cannot be stale needs no checking, and a
  // check that can never fail is a story about a danger that is not there.
  const standing = part.newLines.length
  const put = [...lines.slice(0, from), ...part.oldLines, ...lines.slice(from + standing)]

  // A file that exists only because this change created it, and that the
  // revert has just emptied, goes the way `undo` takes a creation away:
  // leaving an empty file behind is leaving the change half made.
  if (put.length === 0 && change.kept === undefined) {
    rmSync(full, { force: true })
    return {
      ok: true,
      path: fileOf(change.path),
      lines: [from + 1, from + standing],
      removed: true,
    }
  }

  writeFileSync(full, text(put, found.now))
  return {
    ok: true,
    path: fileOf(change.path),
    lines: [from + 1, from + standing],
    removed: false,
  }
}

/** The two sides of a change: what was kept, and what is there now. */
function read(
  workspace: string,
  path: string,
  kept: string | undefined,
): { before: string; now: string } | undefined {
  const full = within(workspace, path)
  if (full === undefined || !existsSync(full)) return undefined

  if (kept === undefined) return { before: '', now: readFileSync(full, 'utf8') }

  const saved = within(join(workspace, UNDO_DIR), kept)
  if (saved === undefined || !existsSync(saved)) return undefined
  return { before: readFileSync(saved, 'utf8'), now: readFileSync(full, 'utf8') }
}

/** Lines back into a file, keeping the ending the file already had. */
function text(lines: string[], like: string): string {
  if (lines.length === 0) return ''
  return like.endsWith('\n') ? `${lines.join('\n')}\n` : lines.join('\n')
}
