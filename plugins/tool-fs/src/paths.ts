import { existsSync, lstatSync, readlinkSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'

/** Enough to follow a chain of links, few enough to stop a loop. */
const MAX_LINK_HOPS = 32

/** A path resolved outside the workspace the agent was given. */
export class WorkspaceBoundaryError extends Error {
  override readonly name = 'WorkspaceBoundaryError'

  constructor(
    readonly requested: string,
    readonly resolved: string,
  ) {
    super(`path escapes the workspace: ${requested}`)
  }
}

/**
 * The agent's own checkout is not there any more.
 *
 * A worktree can go while the agent is still holding it: somebody prunes it, a
 * run beside this one removes it, a script tidies up. Every file tool then
 * failed with `ENOENT ... lstat '<repo>/.aidcrew/wt/main'` — a path the model
 * has never seen, about a thing it did not ask for, suggesting nothing. So it
 * tried again. Watched: an agent spent an entire turn alternating `glob *` and
 * `wc .` against a directory that had stopped existing, because nothing it was
 * told distinguished "that file is missing" from "everything is missing".
 */
export class MissingWorkspaceError extends Error {
  override readonly name = 'MissingWorkspaceError'

  constructor(readonly workspace: string) {
    super(
      `this agent's checkout is gone: ${workspace} no longer exists. ` +
        'Nothing here can be read or written and trying again will not help — ' +
        'say so and stop rather than looking for another way in.',
    )
  }
}

/**
 * Resolves a model-supplied path against the workspace root, refusing anything
 * that lands outside it.
 *
 * Deny by default, because the input comes from a model and the tools that use
 * this result can read and overwrite files. Four things make a naive check
 * wrong, and all four are covered here:
 *
 *  - `..` segments, removed by resolving first;
 *  - symlinks pointing out of the tree, followed with realpath;
 *  - symlinks pointing out of the tree at something that is not there yet,
 *    which realpath cannot follow and which are read by hand instead;
 *  - sibling directories that share the root's string prefix (`/repo-evil` vs
 *    `/repo`), which is why containment is decided with `relative()` and not
 *    `startsWith()`.
 *
 * The path need not exist: resolution walks up to the nearest existing
 * ancestor, resolves that, and re-appends the missing segments — otherwise
 * creating a new file would be impossible.
 */
export function resolveInWorkspace(root: string, requested: string): string {
  // Every file tool comes through here, which makes it the one place that can
  // tell a missing file from a missing workspace — and the raw ENOENT this
  // used to throw told the model neither.
  if (!existsSync(root)) throw new MissingWorkspaceError(root)

  const realRoot = realpathSync(root)
  const resolved = resolveThroughSymlinks(resolve(realRoot, requested))

  const rel = relative(realRoot, resolved)
  const escapes = rel.startsWith('..') || isAbsolute(rel)
  if (escapes) throw new WorkspaceBoundaryError(requested, resolved)

  return resolved
}

function resolveThroughSymlinks(target: string, hops = 0): string {
  const missing: string[] = []
  let current = target

  for (;;) {
    try {
      return join(realpathSync(current), ...missing)
    } catch {
      // A link whose target does not exist yet is still a link: writing
      // through it creates the file it names, wherever that is. realpath
      // refuses to resolve one, and walking past it would land back inside
      // the workspace and call the path contained — so it is followed here,
      // by hand, and the answer is re-resolved in case it is a link too.
      const points = danglingLinkTarget(current)
      if (points !== undefined) {
        // A link that leads back to itself has no answer. Stopping returns
        // the path as written, which is inside the workspace and fails when
        // the tool opens it — the right outcome for a broken link.
        if (hops >= MAX_LINK_HOPS) return join(current, ...missing)
        return resolveThroughSymlinks(join(points, ...missing), hops + 1)
      }

      const parent = dirname(current)
      // Reached the filesystem root without finding anything that exists.
      if (parent === current) return target
      missing.unshift(basename(current))
      current = parent
    }
  }
}

/** What a symlink names, when the thing it names is not there. */
function danglingLinkTarget(path: string): string | undefined {
  try {
    if (!lstatSync(path).isSymbolicLink()) return undefined
    return resolve(dirname(path), readlinkSync(path))
  } catch {
    return undefined
  }
}

/**
 * The repository an agent's worktree was made from, if it is in one.
 *
 * Worktrees live at `<repo>/.aidcrew/wt/<agent>` by convention, which is the
 * only clue available here: a tool is given the directory it works in and
 * nothing about why.
 */
export function repositoryBehind(cwd: string): string | undefined {
  const marker = `${sep}.aidcrew${sep}wt${sep}`
  const at = cwd.indexOf(marker)
  return at === -1 ? undefined : cwd.slice(0, at)
}

/**
 * Why a file is missing, when the reason is worth explaining.
 *
 * An agent works in a worktree, and a worktree is a checkout: a file that was
 * never committed does not exist there, however plainly it sits in the
 * directory the person is looking at. "No such file" is true and useless —
 * the file is right there on their screen — so when it exists in the
 * repository the worktree came from, say that instead.
 */
export function explainMissing(cwd: string, path: string): string | undefined {
  const repository = repositoryBehind(cwd)
  if (repository === undefined) return undefined
  if (!existsSync(join(repository, path))) return undefined

  return (
    `${path} is not in this agent's worktree. It exists in the repository, so it has ` +
    'probably not been committed yet — a worktree is a checkout, and only sees what was.'
  )
}
