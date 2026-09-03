import { realpathSync } from 'node:fs'
import { isAbsolute, relative } from 'node:path'

/**
 * The walk every tool in this plugin shares.
 *
 * It is the one in `plugins/tool-search`, kept the same on purpose: a model
 * that has learnt what `grep` skips should find that `outline` and `symbols`
 * skip the same things, and refuse the same globs, for the same reasons.
 */

/** Directories no code-shape question ever means, and every repository has. */
export const SKIP = new Set([
  'node_modules',
  '.git',
  // Other agents' worktrees: whole copies of this repository, kept under the
  // root by convention. "Where is taskOf declared" has one answer, not one
  // per checkout.
  '.aidcrew',
  'dist',
  'build',
  'coverage',
  '.next',
  '.turbo',
  '.venv',
  '__pycache__',
  'vendor',
  'target',
])

/** The files these tools can read as source. Everything else is data. */
export const SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs']
export const SOURCE_GLOB = '**/*.{ts,tsx,js,jsx,mjs,cjs}'

/** Past this a file is data, not source, and reading it all costs seconds. */
const MAX_FILE_BYTES = 2_000_000

/**
 * Why a glob would leave the workspace, when it would.
 *
 * A glob is not a single path, so it cannot go through `resolveInWorkspace`;
 * the two ways one escapes are being absolute and carrying a `..` segment, and
 * both are refused rather than clamped, because a model that meant to look
 * elsewhere should be told no, not quietly redirected.
 */
export function describesEscape(field: string, glob: string): string | undefined {
  const climbs = glob.split(/[/\\]/).some((part) => part === '..')
  if (!isAbsolute(glob) && !climbs) return undefined

  return (
    `${field} "${glob}" would leave the workspace: an absolute glob or one with a ".." ` +
    'segment is refused, because this tool only reads what is inside the workspace.'
  )
}

/**
 * A found file's path as the model knows it: relative to the workspace.
 *
 * The walk hands back real paths, because `resolveInWorkspace` follows links
 * before it decides what is inside; a workspace that itself sits behind a
 * symlink (macOS's temp directory, a linked checkout) would otherwise show
 * every file as `../../..` away from where the model asked.
 */
export function displayPath(cwd: string, file: string): string {
  let base = cwd
  try {
    base = realpathSync(cwd)
  } catch {
    // The workspace was there a moment ago; the unresolved path is the best left.
  }
  return relative(base, file)
}

/** Every file under `root` matching `pattern`, skipping what nobody means. */
export async function* walk(root: string, pattern: string): AsyncGenerator<string> {
  const glob = new Bun.Glob(pattern)

  for await (const found of glob.scan({ cwd: root, absolute: true, onlyFiles: true, dot: true })) {
    const rel = relative(root, found)
    // Belt and braces: the pattern was checked up front, but a symlink inside
    // the tree can still point a match out of it. Anything that resolves above
    // the root — a relative path starting with `..` — is dropped, never shown.
    if (rel.startsWith('..')) continue
    const parts = rel.split(/[/\\]/)
    if (parts.some((part) => SKIP.has(part))) continue
    yield found
  }
}

/**
 * A file's text, or nothing when it is not text.
 *
 * Binary files are recognised by a null byte in the first few kilobytes, which
 * is what every other tool does and what no real source file contains.
 */
export async function readIfText(path: string): Promise<string | undefined> {
  const file = Bun.file(path)
  if (file.size > MAX_FILE_BYTES) return undefined

  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  if (head.includes(0)) return undefined

  return await file.text().catch(() => undefined)
}
