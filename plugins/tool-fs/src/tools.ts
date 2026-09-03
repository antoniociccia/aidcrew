import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { defineTool } from '@aidcrew/plugin-sdk'
import { z } from 'zod'
import { explainMissing, resolveInWorkspace } from './paths.ts'

/** Guards against a single read filling the whole context window. */
const MAX_LINES = 2000
const MAX_LINE_LENGTH = 2000

export const readTool = defineTool({
  name: 'read',
  reads: true,
  description:
    'Read a text file from the workspace. Output is line-numbered as "N\\ttext"; ' +
    'those numbers are not part of the file. Use offset and limit for large files. ' +
    'To find where something is, use grep rather than reading files to look; to find ' +
    'out how big a file is, use wc.',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root.'),
    offset: z.number().int().min(1).optional().describe('First line to read, 1-based.'),
    limit: z.number().int().min(1).optional().describe('How many lines to read.'),
  }),
  async run({ path, offset = 1, limit = MAX_LINES }, { cwd }) {
    const resolved = resolveInWorkspace(cwd, path)

    let raw: Buffer
    try {
      raw = await readFile(resolved)
    } catch (cause) {
      const because = explainMissing(cwd, path)
      if (because === undefined) throw cause
      return { content: because, isError: true }
    }

    if (raw.byteLength === 0) return { content: `${path} is empty` }
    // A NUL byte never appears in text. Printed, a binary file is a screen of
    // replacement characters that costs a turn and says nothing; `stat` would
    // have said what it was.
    if (raw.includes(0)) {
      return {
        content: `${path} is a binary file (${raw.byteLength} bytes); read is for text, and stat says what a file is`,
        isError: true,
      }
    }
    const text = raw.toString('utf8')

    // A trailing newline terminates the last line, it does not start a new
    // empty one — splitting naively would report a phantom final line.
    const lines = (text.endsWith('\n') ? text.slice(0, -1) : text).split('\n')
    const start = offset - 1
    const window = lines.slice(start, start + Math.min(limit, MAX_LINES))

    const body = window
      .map((line, index) => `${start + index + 1}\t${truncate(line, MAX_LINE_LENGTH)}`)
      .join('\n')

    // What was not shown, and how to get it: a count alone sent the next
    // read back to line one.
    const remaining = lines.length - (start + window.length)
    const next = start + window.length + 1
    return {
      content:
        remaining > 0
          ? `${body}\n... ${remaining} more lines (${lines.length} in all); continue with offset=${next}`
          : body,
    }
  },
})

export const writeTool = defineTool({
  name: 'write',
  description:
    'Write a text file in the workspace, creating parent directories as needed. ' +
    'Overwrites the file completely; use edit to change part of an existing file.',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root.'),
    content: z.string().describe('The complete new contents of the file.'),
  }),
  async run({ path, content }, { cwd }) {
    const resolved = resolveInWorkspace(cwd, path)
    await mkdir(dirname(resolved), { recursive: true })
    await writeFile(resolved, content, 'utf8')
    return { content: `wrote ${path} (${content.length} bytes)` }
  },
})

export const editTool = defineTool({
  name: 'edit',
  description:
    'Replace an exact string in a file. oldString must appear exactly once unless ' +
    'replaceAll is set, and must not include the line numbers that read adds.',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace root.'),
    oldString: z.string().min(1).describe('Exact text to replace, including indentation.'),
    newString: z.string().describe('Replacement text.'),
    replaceAll: z.boolean().optional().describe('Replace every occurrence.'),
  }),
  async run({ path, oldString, newString, replaceAll = false }, { cwd }) {
    if (oldString === newString) {
      return { content: 'oldString and newString are identical: nothing to do', isError: true }
    }

    const resolved = resolveInWorkspace(cwd, path)
    const text = await readFile(resolved, 'utf8')
    const occurrences = text.split(oldString).length - 1

    if (occurrences === 0) {
      // Not as written, so as meant. Indentation is the one thing a model gets
      // wrong on purpose — it cannot see a tab — and "not found" for a line
      // that is plainly there cost a turn to re-read and quote again, three
      // times in one afternoon. Matched with whitespace loosened, the edit
      // goes through when it is unambiguous, and says it did.
      const loose = findLoosely(text, oldString)
      if (loose.at === 'one') {
        const replacement = reindented(newString, oldString, loose.indent)
        const updated = text.slice(0, loose.start) + replacement + text.slice(loose.end)
        await writeFile(resolved, updated, 'utf8')
        return { content: `edited ${path} (1 replacement, matched with different whitespace)` }
      }
      const nearest = nearestLine(text, oldString)
      return {
        content:
          `oldString not found in ${path}` +
          (loose.at === 'many' ? ' (it appears more than once with different whitespace)' : '') +
          (nearest === undefined ? '' : `; the nearest line is ${nearest}`),
        isError: true,
      }
    }
    // Refusing here rather than replacing the first match: the model gave an
    // ambiguous instruction, and guessing silently edits the wrong line.
    if (occurrences > 1 && !replaceAll) {
      return {
        content: `oldString appears ${occurrences} times in ${path}; add more surrounding context or set replaceAll`,
        isError: true,
      }
    }

    // A function replacer, so `$&`, `` $` ``, `$'` and `$$` in newString are put
    // in as typed rather than read as substitution patterns — passing the
    // string directly let an edited shell script gain a duplicated line and
    // lose a `$`, silently, reported as a clean replacement. The replaceAll
    // branch already avoids this by joining rather than substituting.
    const updated = replaceAll
      ? text.split(oldString).join(newString)
      : text.replace(oldString, () => newString)
    await writeFile(resolved, updated, 'utf8')

    return { content: `edited ${path} (${occurrences} replacement${occurrences > 1 ? 's' : ''})` }
  },
})

function truncate(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max)}… [truncated]` : line
}

/**
 * A string with its whitespace loosened: runs of spaces and tabs become one
 * space, indentation and trailing whitespace go, newlines stay. Each kept
 * character remembers where it came from, so a match in the loose text can be
 * cut out of the real one.
 */
function loosen(text: string): { loose: string; from: number[] } {
  let loose = ''
  const from: number[] = []
  let pending: number | undefined

  for (let at = 0; at < text.length; at++) {
    const char = text[at] as string
    if (char === ' ' || char === '\t') {
      pending = at
      continue
    }
    if (char === '\n') {
      pending = undefined
      loose += '\n'
      from.push(at)
      continue
    }
    if (pending !== undefined && loose !== '' && !loose.endsWith('\n')) {
      loose += ' '
      from.push(pending)
    }
    pending = undefined
    loose += char
    from.push(at)
  }

  return { loose, from }
}

/**
 * Where `wanted` is in `text` once whitespace is ignored: exactly one place,
 * several, or none. `indent` is what the file has in front of the match,
 * which is what the replacement's own indentation is measured against.
 */
function findLoosely(
  text: string,
  wanted: string,
): { at: 'one'; start: number; end: number; indent: string } | { at: 'many' | 'none' } {
  const target = loosen(wanted).loose
  if (target === '') return { at: 'none' }
  const hay = loosen(text)

  const first = hay.loose.indexOf(target)
  if (first === -1) return { at: 'none' }
  if (hay.loose.indexOf(target, first + target.length) !== -1) return { at: 'many' }

  const start = hay.from[first] as number
  const end = (hay.from[first + target.length - 1] as number) + 1
  const lineStart = text.lastIndexOf('\n', start - 1) + 1
  return { at: 'one', start, end, indent: text.slice(lineStart, start) }
}

/**
 * The replacement with the model's indentation swapped for the file's.
 *
 * The match begins at the first non-blank character, so what the file had in
 * front of it stays; the replacement then must not bring its own copy, and
 * its later lines should step in the file's unit rather than the model's.
 */
function reindented(replacement: string, wanted: string, indent: string): string {
  const own = /^[ \t]*/.exec(wanted)?.[0] ?? ''
  const lines = replacement.split('\n')
  const first = lines[0] ?? ''
  const rest = lines.slice(1)
  const head = first.startsWith(own) ? first.slice(own.length) : first.replace(/^[ \t]+/, '')
  const body =
    own === ''
      ? rest
      : rest.map((line) => (line.startsWith(own) ? indent + line.slice(own.length) : line))
  return [head, ...body].join('\n')
}

/** The line most like the first line of what was wanted, to point at. */
function nearestLine(text: string, wanted: string): string | undefined {
  const sought = loosen(wanted.split('\n').find((line) => line.trim() !== '') ?? '').loose
  if (sought === '') return undefined
  const lines = text.split('\n')
  const probe = sought.slice(0, Math.max(12, Math.floor(sought.length * 0.6)))

  for (const [at, line] of lines.entries()) {
    const loose = loosen(line).loose
    if (loose === sought || loose.includes(probe)) return `line ${at + 1}: ${line.trim()}`
  }
  return undefined
}
