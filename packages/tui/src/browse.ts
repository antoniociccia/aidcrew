import { readdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

/**
 * Walking the filesystem to pick a directory.
 *
 * Only directories are listed. What is being chosen is a place to read skills
 * or agents from, and offering files would let someone pick one and then
 * wonder why nothing loaded.
 */

export type Entry = {
  name: string
  path: string
  /** True for the entry that goes up, which is not a real child. */
  up?: boolean
}

/**
 * What is inside `at`, with the way back first.
 *
 * A directory that cannot be read comes back with only the way back rather
 * than throwing: a permission error in the middle of a picker is a dead end,
 * and the parent is always somewhere to go.
 */
export function list(at: string): Entry[] {
  const parent = dirname(at)
  const entries: Entry[] = parent === at ? [] : [{ name: '..', path: parent, up: true }]

  let names: string[]
  try {
    names = readdirSync(at)
  } catch {
    return entries
  }

  const directories = names
    .filter((name) => !name.startsWith('.') || name === '.claude' || name === '.aidcrew')
    .filter((name) => {
      try {
        return statSync(join(at, name)).isDirectory()
      } catch {
        // A broken symlink, or something that vanished between the listing and
        // the check. Not being able to describe it is reason enough to skip it.
        return false
      }
    })
    .sort((a, b) => a.localeCompare(b))

  return [...entries, ...directories.map((name) => ({ name, path: join(at, name) }))]
}

/**
 * The path as it should be written into the project config.
 *
 * Somewhere inside the project is written relative to it, so the file still
 * makes sense on somebody else's machine; the home directory is written with a
 * tilde for the same reason. Anything else stays absolute, because shortening
 * it would be a guess.
 */
export function forConfig(path: string, cwd: string, home = homedir()): string {
  const full = resolve(path)

  if (full === cwd) return '.'
  if (full.startsWith(`${cwd}/`)) return `./${full.slice(cwd.length + 1)}`
  if (full === home) return '~'
  if (full.startsWith(`${home}/`)) return `~/${full.slice(home.length + 1)}`

  return full
}

/** Where a picker should open: the project, since that is what is being set up. */
export function startAt(cwd: string): string {
  return resolve(cwd)
}

/** Directories no completion ever means, and every repository has. */
const SKIP = ['node_modules', '.git', 'dist', 'build', 'coverage', '.next', '.turbo', 'vendor']

/**
 * Every file in the project, for completing a name typed with `@`.
 *
 * Read once when the project opens and held: a person types faster than a
 * filesystem walks, and a suggestion that arrives after the next keystroke is
 * a suggestion nobody sees. Capped, because a repository with a hundred
 * thousand files would spend a second of somebody's attention on a list they
 * will filter to six entries anyway.
 */
export async function projectFiles(cwd: string, limit = 20_000): Promise<string[]> {
  const found: string[] = []

  try {
    for await (const path of new Bun.Glob('**/*').scan({ cwd, onlyFiles: true })) {
      if (SKIP.some((skip) => path.startsWith(`${skip}/`) || path.includes(`/${skip}/`))) continue
      found.push(path)
      if (found.length >= limit) break
    }
  } catch {
    // A directory that cannot be walked completes nothing, which is a smaller
    // problem than refusing to open the project.
    return []
  }

  return found.sort()
}

/**
 * Whether a path is a directory that can be opened.
 *
 * `Bun.file()` describes a file, and answers `false` for every directory there
 * has ever been — including the one you are standing in. Used to decide
 * whether a project could be opened, it refused all of them, and the screen
 * for opening a project could not open a project.
 */
export function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}
