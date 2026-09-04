import { homedir, tmpdir } from 'node:os'
import { isAbsolute, resolve, sep } from 'node:path'

/**
 * Whether a shell command would carry an agent out of its checkout.
 *
 * Every file tool refuses a path outside the workspace. The shell could not,
 * because a shell goes where it is told — and watched on a real run, a coder
 * in its own worktree ran `cd /repos/app && git switch -c work/thing`, which
 * moved the person's own checkout onto a branch of the coder's and left the
 * harness counting the job's commits in the wrong place. The one place a
 * shell changes where it is, it is asked where.
 *
 * Only the places a command names: `cd`, `pushd` and `git -C`. A command
 * that reaches outside through an absolute file path is still allowed to —
 * the file tools already draw that line, and a shell that could not read
 * /etc/hosts would be no shell.
 */

/** Where scratch files go, which is nobody's checkout and everybody's to use. */
const SCRATCH = [tmpdir(), '/tmp', '/private/tmp']

/** The name of the first directory outside the checkout the command would go to, or nothing. */
export function leavesWorkspace(command: string, cwd: string): string | undefined {
  let current = cwd
  for (const segment of command.split(/&&|\|\||;|\||\n/)) {
    const move = /^\s*(?:cd|pushd)\s+(\S+)/.exec(segment)
    const pointed = /^\s*git\s+-C\s+(\S+)/.exec(segment)
    const target = move?.[1] ?? pointed?.[1]
    if (target === undefined) continue

    const where = resolveFrom(current, target)
    // Scratch is anybody's — unless it is where the checkout itself lives,
    // in which case climbing out of the checkout is still leaving it.
    const scratch = SCRATCH.some((root) => inside(where, root)) && !inside(cwd, where)
    if (!inside(where, cwd) && !scratch) return where
    if (move) current = where
  }
  return undefined
}

function resolveFrom(current: string, target: string): string {
  const bare = target.replace(/^["']|["']$/g, '')
  const expanded = bare === '~' || bare.startsWith('~/') ? homedir() + bare.slice(1) : bare
  return isAbsolute(expanded) ? resolve(expanded) : resolve(current, expanded)
}

function inside(path: string, root: string): boolean {
  const base = resolve(root)
  return path === base || path.startsWith(base + sep)
}
