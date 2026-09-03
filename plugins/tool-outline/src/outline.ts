import { stat } from 'node:fs/promises'
import { defineTool } from '@aidcrew/plugin-sdk'
import { explainMissing, resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'
import { describesEscape, displayPath, readIfText, SOURCE_GLOB, walk } from './walk.ts'

/**
 * What a file declares, without reading it.
 *
 * Reading an 1,800-line file to learn what it exports costs about eighteen
 * thousand tokens; this answers the same question in a few dozen. It is a set
 * of regular expressions and not a parser, which is a deliberate trade: a
 * parser is a dependency, and every export form that matters sits at the start
 * of a line, where a regular expression anchored there cannot be fooled by
 * the same words inside a string or a comment. What it does not see is an
 * `export` at the start of a line inside a multi-line template or block
 * comment — and tracking those would mean tracking `/*` inside strings, where
 * globs like `**\/*` live.
 */

/** Files per call; enough to outline a package, few enough to read. */
const FILE_LIMIT = 50
/** Exports per file. A generated declaration file can go far past this. */
const ENTRY_LIMIT = 500

type Entry = { line: number; kind: string; name: string }

export const outlineTool = defineTool({
  name: 'outline',
  reads: true,
  description:
    'What a TypeScript or JavaScript file exports — every function, class, type, constant and ' +
    "re-export, with its line — without reading the file. Use it before read to learn a file's " +
    'shape; give a directory (optionally with a glob) to outline a package at once.',
  schema: z.object({
    path: z
      .string()
      .describe(
        'File to outline, or a directory to outline the source files in, relative to the workspace.',
      ),
    glob: z
      .string()
      .optional()
      .describe(
        'With a directory: glob selecting the files to outline, e.g. "**/*.ts". At most 50 files.',
      ),
  }),
  async run({ path, glob }, { cwd }) {
    const resolved = resolveInWorkspace(cwd, path)

    const info = await stat(resolved).catch(() => undefined)
    if (info === undefined) {
      return { content: explainMissing(cwd, path) ?? `${path} does not exist`, isError: true }
    }

    if (info.isDirectory()) return await outlineMany(cwd, resolved, path, glob)

    if (glob !== undefined) {
      return { content: `${path} is a file; a glob needs a directory to search in`, isError: true }
    }

    const text = await readIfText(resolved)
    if (text === undefined) {
      return { content: `${path} is binary or too large to outline`, isError: true }
    }

    return { content: format(outline(text), path) }
  },
})

/** A header per file, so the model can tell whose exports it is looking at. */
async function outlineMany(cwd: string, root: string, path: string, glob: string | undefined) {
  if (glob !== undefined) {
    const leaving = describesEscape('glob', glob)
    if (leaving !== undefined) return { content: leaving, isError: true }
  }
  const pattern = glob ?? SOURCE_GLOB

  const files: string[] = []
  for await (const file of walk(root, pattern)) files.push(file)
  if (files.length === 0) return { content: `no files match ${pattern} under ${path}` }

  // Alphabetical, so which fifty are shown does not depend on the filesystem.
  files.sort()
  const shown = files.slice(0, FILE_LIMIT)

  const sections: string[] = []
  for (const file of shown) {
    const rel = displayPath(cwd, file)
    const text = await readIfText(file)
    const body =
      text === undefined ? '  binary or too large to outline' : indent(format(outline(text), rel))
    sections.push(`${rel}\n${body}`)
  }

  const cut = files.length - shown.length
  const tail = cut > 0 ? `\n\n... and ${cut} more files past the limit of ${FILE_LIMIT}` : ''
  return { content: sections.join('\n\n') + tail }
}

function format(entries: Entry[], path: string): string {
  if (entries.length === 0) return `no exports in ${path}`

  const shown = entries.slice(0, ENTRY_LIMIT)
  const lines = shown.map((entry) => `${entry.line}: ${entry.kind} ${entry.name}`.trimEnd())
  if (entries.length > shown.length) {
    lines.push(`... and ${entries.length - shown.length} more past the limit of ${ENTRY_LIMIT}`)
  }
  return lines.join('\n')
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((line) => `  ${line}`)
    .join('\n')
}

/**
 * Every export in `text`, in order, with the line each is on.
 *
 * Each matcher is anchored at the start of a line (`^\s*export`): that is what
 * keeps `const fixture = "export { x }"` and `// export { x }` out of the
 * result, and why nothing in here needs to know what a string is.
 */
function outline(text: string): Entry[] {
  const lines = text.split('\n')
  const entries: Entry[] = []

  for (let at = 0; at < lines.length; at += 1) {
    const line = lines[at] ?? ''

    const list = EXPORT_LIST.exec(line)
    if (list !== null) {
      const { found, endedAt } = exportList(lines, at, list[2] ?? '', list[1] !== undefined)
      entries.push(...found)
      at = endedAt
      continue
    }

    entries.push(...single(line, at + 1))
  }

  return entries
}

const EXPORT_LIST = /^\s*export\s+(type\s+)?\{(.*)$/
const EXPORT_STAR = /^\s*export\s+\*(?:\s+as\s+([\w$]+))?\s+from\s*['"]([^'"]+)['"]/
const EXPORT_DEFAULT = /^\s*export\s+default\s+(.*)$/
const EXPORT_DECLARATION =
  /^\s*export\s+(?:declare\s+)?(?:abstract\s+)?(?:async\s+)?(function|class|type|interface|enum|namespace|const|let|var)\b\s*(.*)$/
/** `module.exports = …` and `exports.name = …`, the CommonJS shapes of the same thing. */
const CJS_DEFAULT = /^\s*module\.exports\s*=/
const CJS_NAMED = /^\s*(?:module\.)?exports\.([\w$]+)\s*=/

const IDENTIFIER = /^[\w$]+/
const DEFAULT_FUNCTION = /^(?:async\s+)?function\s*\*?\s*([\w$]+)/
const DEFAULT_CLASS = /^(?:abstract\s+)?(?:class|interface)\s+([\w$]+)/
/** One name in an export list: `a`, `b as c`, `type T`, `default as x`. */
const LIST_NAME = /^(?:type\s+)?([\w$]+)(?:\s+as\s+([\w$]+))?$/
/** One binding in a destructuring pattern: `a`, `key: a`, `a = 1`, `...a`. */
const BINDING = /^(?:\.\.\.)?\s*(?:[\w$]+\s*:\s*)?([\w$]+)/

/** The export forms that fit on the line they start on. */
function single(line: string, at: number): Entry[] {
  const star = EXPORT_STAR.exec(line)
  if (star !== null) {
    const name = star[1] === undefined ? '*' : `* as ${star[1]}`
    return [{ line: at, kind: 're-export', name: `${name} from ${star[2]}` }]
  }

  const fallback = EXPORT_DEFAULT.exec(line)
  if (fallback !== null) {
    const rest = fallback[1] ?? ''
    const named = DEFAULT_FUNCTION.exec(rest) ?? DEFAULT_CLASS.exec(rest)
    return [{ line: at, kind: 'default', name: named?.[1] ?? '' }]
  }

  const declaration = EXPORT_DECLARATION.exec(line)
  if (declaration !== null) return declared(declaration[1] ?? '', declaration[2] ?? '', at)

  if (CJS_DEFAULT.test(line)) return [{ line: at, kind: 'default', name: '' }]
  const named = CJS_NAMED.exec(line)
  if (named !== null) return [{ line: at, kind: 'export', name: named[1] ?? '' }]

  return []
}

function declared(kind: string, rest: string, at: number): Entry[] {
  // `const enum E` is an enum that happens to start with the word const.
  if (kind === 'const' && /^enum\s+/.test(rest)) return declared('enum', rest.slice(4).trim(), at)
  // `function* gen` — the star is not part of the name.
  const body = kind === 'function' ? rest.replace(/^\*\s*/, '') : rest

  if (/^[{[]/.test(body)) return bindings(body).map((name) => ({ line: at, kind, name }))

  const name = IDENTIFIER.exec(body)?.[0]
  return name === undefined ? [] : [{ line: at, kind, name }]
}

/**
 * The names in `export { … }`, whether it closes on the same line or several
 * lines down, each reported on the line it is actually written on.
 */
function exportList(
  lines: string[],
  start: number,
  afterBrace: string,
  typeOnly: boolean,
): { found: Entry[]; endedAt: number } {
  const { pieces, closing, endedAt } = listPieces(lines, start, afterBrace)
  const from = /^\s*from\s*['"]([^'"]+)['"]/.exec(closing)?.[1]

  const found = pieces.flatMap(({ line, piece }) => {
    const name = LIST_NAME.exec(piece)
    if (name === null) return []
    const shown = name[2] === undefined ? (name[1] ?? '') : `${name[1]} as ${name[2]}`
    if (from !== undefined) return [{ line, kind: 're-export', name: `${shown} from ${from}` }]
    return [{ line, kind: typeOnly ? 'type' : 'export', name: shown }]
  })

  return { found, endedAt }
}

/** The comma-separated pieces between the braces, each with the line it is on. */
function listPieces(
  lines: string[],
  start: number,
  afterBrace: string,
): { pieces: { line: number; piece: string }[]; closing: string; endedAt: number } {
  const pieces: { line: number; piece: string }[] = []
  let cursor = start
  let body = afterBrace

  for (;;) {
    const close = body.indexOf('}')
    const chunk = close === -1 ? body : body.slice(0, close)
    for (const piece of chunk.split(',')) pieces.push({ line: cursor + 1, piece: piece.trim() })
    if (close !== -1) return { pieces, closing: body.slice(close + 1), endedAt: cursor }
    cursor += 1
    // An unterminated list is a syntax error; stop at the end rather than loop.
    if (cursor >= lines.length) return { pieces, closing: '', endedAt: cursor }
    body = lines[cursor] ?? ''
  }
}

/** `export const { a, b: c } = …` declares a and c, and both are worth listing. */
function bindings(pattern: string): string[] {
  const close = pattern.search(/[}\]]/)
  const inside = pattern.slice(1, close === -1 ? undefined : close)
  return inside
    .split(',')
    .map((piece) => BINDING.exec(piece.trim())?.[1])
    .filter((name): name is string => name !== undefined)
}
