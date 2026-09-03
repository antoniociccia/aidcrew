import { homedir } from 'node:os'

/**
 * Hiding where the work is, for a screen somebody else will see.
 *
 * A terminal recording, a screenshot in an issue, a pair-programming call:
 * all of them publish an absolute path that says who you are and, often
 * enough, who you work for. `/Users/ada/clients/…` is a client list.
 *
 * Off by default, because the path is genuinely useful the rest of the time —
 * it is how you tell one checkout from another at a glance. This is for the
 * moments when the screen is not just yours.
 */

/**
 * A path with the private part taken out.
 *
 * The home directory becomes `~`, which everyone reads without thinking, and
 * anything above the project keeps only its last two segments: enough to tell
 * two checkouts apart, not enough to say where they live.
 */
export function shorten(path: string, home = homedir()): string {
  if (path === '') return path

  const normalised = path.replace(/\\/g, '/')
  const at = normalised.replace(home.replace(/\\/g, '/'), '~')
  if (at.startsWith('~')) return at

  // A path outside the home directory says less about a person, but an
  // absolute one still says which machine and which account. Kept to its tail.
  const parts = at.split('/').filter((part) => part !== '')
  return parts.length <= 2 ? at : `…/${parts.slice(-2).join('/')}`
}

/**
 * The same, applied to text that merely contains paths.
 *
 * Tool calls and errors carry them in the middle of a sentence — "ENOENT: no
 * such file or directory, open '/Users/…'" — and a transcript is the thing
 * most often on screen when somebody is recording.
 */
export function hidePaths(text: string, home = homedir()): string {
  if (text === '') return text
  const escaped = home.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  return text.replace(new RegExp(escaped, 'g'), '~')
}
