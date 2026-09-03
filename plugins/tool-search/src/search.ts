import { stat } from 'node:fs/promises'
import { isAbsolute, relative } from 'node:path'
import { defineTool } from '@aidcrew/plugin-sdk'
import { resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'

/**
 * Finding things, without going through the shell.
 *
 * An agent that has to reach for `bash` to look something up pays for it
 * twice: the guards treat every shell command as something that might change
 * the machine, so reading gets an approval prompt, and the output arrives in
 * whatever shape that platform's tools happen to use. These two do the most
 * common half of that work directly, in a way that answers the same on
 * Windows, and that nothing needs to be asked about because they only read.
 */

/** Directories no search ever means, and every repository has. */
const SKIP = new Set([
  'node_modules',
  '.git',
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

/** Enough matches to see the shape of a thing, few enough to read. */
const MATCH_LIMIT = 100
const FILE_LIMIT = 200
/** Past this a file is data, not source, and reading it all costs seconds. */
const MAX_FILE_BYTES = 2_000_000
const MAX_LINE_LENGTH = 400

export const grepTool = defineTool({
  name: 'grep',
  reads: true,
  description:
    'Search file contents with a regular expression. Returns "path:line: text" for each match. ' +
    'Prefer this over running grep through bash: it is faster, it skips node_modules and ' +
    'build output, and it needs no approval because it only reads.',
  schema: z.object({
    pattern: z.string().describe('JavaScript regular expression.'),
    path: z.string().optional().describe('Directory to search in, relative to the workspace.'),
    include: z
      .string()
      .optional()
      .describe('Glob limiting which files are searched, e.g. "**/*.ts".'),
    ignoreCase: z.boolean().optional().describe('Match regardless of case.'),
    limit: z.number().int().min(1).optional().describe('Stop after this many matches.'),
    context: z
      .number()
      .int()
      .min(0)
      .max(5)
      .optional()
      .describe('Lines to show either side of each match, as "path:line- text".'),
  }),
  async run(
    { pattern, path = '.', include = '**/*', ignoreCase, limit = MATCH_LIMIT, context = 0 },
    { cwd },
  ) {
    const root = resolveInWorkspace(cwd, path)

    // Only `path` used to be checked; the include glob went straight to
    // Bun.Glob, so `../secret/*` or an absolute glob read files the agent was
    // never given. A glob cannot go through resolveInWorkspace — it is not a
    // single path — so it is refused up front instead.
    const leaving = describesEscape('include', include)
    if (leaving !== undefined) return { content: leaving, isError: true }

    let expression: RegExp
    try {
      expression = new RegExp(pattern, ignoreCase ? 'i' : '')
    } catch (cause) {
      return {
        content: `"${pattern}" is not a valid regular expression: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
        isError: true,
      }
    }

    const { found, more } = await scan({ root, cwd, include, expression, limit, context })

    if (found.length === 0) {
      return { content: `no matches for /${pattern}/ under ${path}` }
    }

    return {
      content:
        more > 0
          ? `${found.join('\n')}\n... and more, past the limit of ${limit}`
          : found.join('\n'),
    }
  },
})

export const globTool = defineTool({
  name: 'glob',
  reads: true,
  description:
    'List files matching a glob pattern, most recently changed first. ' +
    'Use it to find files by name or extension; use grep to find them by content.',
  schema: z.object({
    pattern: z.string().describe('Glob pattern, e.g. "**/*.test.ts" or "src/**/auth*".'),
    path: z.string().optional().describe('Directory to search in, relative to the workspace.'),
    limit: z.number().int().min(1).optional().describe('Stop after this many files.'),
  }),
  async run({ pattern, path = '.', limit = FILE_LIMIT }, { cwd }) {
    const root = resolveInWorkspace(cwd, path)

    // The pattern is a glob and cannot go through resolveInWorkspace, so an
    // absolute one or one that climbs with `..` — which Bun.Glob would follow
    // out of the workspace — is refused here before anything is scanned.
    const leaving = describesEscape('pattern', pattern)
    if (leaving !== undefined) return { content: leaving, isError: true }

    const files: { path: string; changed: number }[] = []
    for await (const file of walk(root, pattern)) {
      const changed = await stat(file)
        .then((info) => info.mtimeMs)
        .catch(() => 0)
      files.push({ path: relative(cwd, file), changed })
    }

    if (files.length === 0) return { content: `no files match ${pattern} under ${path}` }

    // Newest first: when several files could be the one meant, the one touched
    // most recently usually is.
    files.sort((a, b) => b.changed - a.changed)
    const shown = files.slice(0, limit)

    return {
      content:
        files.length > shown.length
          ? `${shown.map((file) => file.path).join('\n')}\n... and ${files.length - shown.length} more`
          : shown.map((file) => file.path).join('\n'),
    }
  },
})

/**
 * Walks the files and collects the matching lines.
 *
 * Apart so that the tool itself reads as what it does — check the pattern,
 * search, say what was found — rather than as a nest of loops with two
 * different reasons to stop in the middle of it.
 */
async function scan(options: {
  root: string
  cwd: string
  include: string
  expression: RegExp
  limit: number
  context: number
}): Promise<{ found: string[]; more: number }> {
  const found: string[] = []
  let matches = 0
  let more = 0

  for await (const file of walk(options.root, options.include)) {
    if (matches >= options.limit) {
      more += 1
      continue
    }

    const text = await readIfText(file)
    if (text === undefined) continue

    const shown = relative(options.cwd, file)
    const lines = text.split('\n')

    // Which lines match, known before anything is printed: a match inside
    // the context of the match before it is still a match, and was being
    // printed as context because the window had already covered it.
    const hits = new Set<number>()
    for (const [at, line] of lines.entries()) {
      if (!options.expression.test(line)) continue
      if (matches >= options.limit) {
        more += 1
        break
      }
      matches += 1
      hits.add(at)
    }

    // The last line already printed for this file, so context around two
    // matches close together is shown once, and a gap between groups is
    // marked the way grep marks it.
    let printed = -1
    for (const at of hits) {
      const first = Math.max(0, at - options.context)
      const last = Math.min(lines.length - 1, at + options.context)
      if (options.context > 0 && printed >= 0 && first > printed + 1) found.push('--')
      for (let row = Math.max(first, printed + 1); row <= last; row++) {
        const mark = hits.has(row) ? ':' : '-'
        found.push(`${shown}:${row + 1}${mark} ${truncate((lines[row] ?? '').trim())}`)
      }
      printed = Math.max(printed, last)
    }
  }

  return { found, more }
}

/**
 * Why a glob would leave the workspace, when it would.
 *
 * A glob is not a single path, so it cannot go through `resolveInWorkspace`;
 * the two ways one escapes are being absolute and carrying a `..` segment, and
 * both are refused rather than clamped, because a model that meant to search
 * elsewhere should be told no, not quietly redirected.
 */
function describesEscape(field: 'include' | 'pattern', glob: string): string | undefined {
  const climbs = glob.split(/[/\\]/).some((part) => part === '..')
  if (!isAbsolute(glob) && !climbs) return undefined

  return (
    `${field} "${glob}" would leave the workspace: an absolute glob or one with a ".." ` +
    'segment is refused, because this tool only reads what is inside the workspace.'
  )
}

/** Every file under `root` matching `pattern`, skipping what nobody means. */
async function* walk(root: string, pattern: string): AsyncGenerator<string> {
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
 * is what every other tool does and what no real source file contains. Reading
 * one as text produces matches nobody can act on and lines that break the
 * terminal.
 */
async function readIfText(path: string): Promise<string | undefined> {
  const file = Bun.file(path)
  if (file.size > MAX_FILE_BYTES) return undefined

  const head = new Uint8Array(await file.slice(0, 4096).arrayBuffer())
  if (head.includes(0)) return undefined

  return await file.text().catch(() => undefined)
}

function truncate(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line
}
