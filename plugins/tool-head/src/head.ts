import { open, stat } from 'node:fs/promises'
import { defineTool } from '@aidcrew/plugin-sdk'
import { explainMissing, resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'

/**
 * The beginning or the end of a file, without the middle.
 *
 * `read` hands a file over from the top, so a model that wants to know how a
 * forty-thousand-line log ended has to page to the end of it, or ask `bash`
 * for `tail` and pay for an approval. This reads from whichever end was asked
 * for, one chunk at a time, and stops as soon as it has enough line breaks —
 * the end of a large file costs what the end of a small one costs. What it
 * leaves out it counts, so the model knows how much file there is.
 */

/** One read at a time: room for twenty lines of anything, small enough to be nothing. */
export const CHUNK = 16_384
/** Past this a file's "lines" are not lines, and gathering more would be reading the file. */
const MAX_BYTES = 1_000_000
const SNIFF = 8_192
const DEFAULT_LINES = 20
const MAX_LINES = 1_000
const MAX_LINE_LENGTH = 2_000
const NEWLINE = 0x0a

/** A file as a size and ranged reads, so that a test can count what was read. */
export type Source = {
  size: number
  read(start: number, end: number): Promise<Uint8Array>
  close(): Promise<void>
}

/** The lines picked from one end, and whether they had to be cut short. */
type Picked = { lines: string[]; cut: boolean }

export const headTool = defineTool({
  name: 'head',
  reads: true,
  description:
    'Show the first or last N lines of a file (default 20, from the start), numbered, with ' +
    "the file's total line count. Cheap even on a huge log, because it reads only the end it " +
    'was asked for. Use read for a range in the middle.',
  schema: z.object({
    path: z.string().describe('File path, relative to the workspace.'),
    lines: z
      .number()
      .int()
      .min(1)
      .max(MAX_LINES)
      .optional()
      .describe('How many lines to show. Default 20.'),
    from: z.enum(['start', 'end']).optional().describe('Which end of the file. Default start.'),
  }),
  async run({ path, lines = DEFAULT_LINES, from = 'start' }, { cwd }) {
    const resolved = resolveInWorkspace(cwd, path)

    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(resolved)
    } catch {
      return { content: explainMissing(cwd, path) ?? `${path} does not exist`, isError: true }
    }
    if (info.isDirectory()) {
      return { content: `${path} is a directory; use tree to list it`, isError: true }
    }
    if (info.size === 0) return { content: `${path} is empty` }

    const source = await openSource(resolved)
    try {
      const sniff = await source.read(0, Math.min(SNIFF, source.size))
      if (sniff.includes(0)) {
        return {
          content: `${path} looks binary (a NUL byte in its first ${sniff.length} bytes); use stat for its size and kind`,
          isError: true,
        }
      }

      const total = await countLines(source)
      const picked =
        from === 'end' ? await lastLines(source, lines) : await firstLines(source, lines)
      return { content: present(from, total, picked) }
    } finally {
      await source.close()
    }
  },
})

export async function openSource(path: string): Promise<Source> {
  const handle = await open(path, 'r')
  const { size } = await handle.stat()

  return {
    size,
    async read(start, end) {
      const length = Math.max(0, Math.min(end, size) - start)
      const buffer = new Uint8Array(length)
      let filled = 0
      while (filled < length) {
        const { bytesRead } = await handle.read(buffer, filled, length - filled, start + filled)
        if (bytesRead === 0) break
        filled += bytesRead
      }
      return filled === length ? buffer : buffer.subarray(0, filled)
    },
    close: () => handle.close(),
  }
}

/**
 * How many lines the file has, counted one chunk at a time. Every byte goes
 * past, but never more than a chunk of them is held, which is what makes this
 * affordable on a file that `read` would have to swallow whole.
 */
export async function countLines(source: Source): Promise<number> {
  if (source.size === 0) return 0

  let count = 0
  let last = 0
  for (let at = 0; at < source.size; at += CHUNK) {
    const bytes = await source.read(at, Math.min(at + CHUNK, source.size))
    if (bytes.length === 0) break
    count += newlinesIn(bytes)
    last = bytes[bytes.length - 1] as number
  }
  // A last line with no newline after it is still a line.
  return last === NEWLINE ? count : count + 1
}

/** The first `wanted` lines, reading forward until that many line breaks have gone by. */
export async function firstLines(source: Source, wanted: number): Promise<Picked> {
  const parts: Uint8Array[] = []
  let gathered = 0
  let newlines = 0
  let at = 0

  while (at < source.size && newlines < wanted && gathered < MAX_BYTES) {
    const bytes = await source.read(at, Math.min(at + CHUNK, source.size))
    if (bytes.length === 0) break
    parts.push(bytes)
    gathered += bytes.length
    at += bytes.length
    newlines += newlinesIn(bytes)
  }

  const all = concat(parts)
  if (newlines >= wanted) {
    return { lines: split(decode(all.subarray(0, nthNewline(all, wanted) + 1))), cut: false }
  }
  // Either the whole file fit, or a line is longer than the budget and the
  // last line shown is only the start of one.
  return { lines: split(decode(all)), cut: at < source.size }
}

/**
 * The last `wanted` lines, reading backward from the end until that many
 * line breaks have been passed — one more when the file ends in a newline,
 * which terminates the last line rather than starting another.
 */
export async function lastLines(source: Source, wanted: number): Promise<Picked> {
  const parts: Uint8Array[] = []
  let gathered = 0
  let newlines = 0
  let at = source.size
  let needed = wanted

  while (at > 0 && newlines < needed && gathered < MAX_BYTES) {
    const start = Math.max(0, at - CHUNK)
    const bytes = await source.read(start, at)
    if (parts.length === 0 && bytes[bytes.length - 1] === NEWLINE) needed += 1
    parts.unshift(bytes)
    gathered += bytes.length
    at = start
    newlines += newlinesIn(bytes)
  }

  const all = concat(parts)
  if (newlines >= needed) {
    // Cutting just after a newline keeps the decoding on a character boundary.
    const lines = split(decode(all.subarray(newlineFromEnd(all, needed) + 1)))
    return { lines: lines.slice(-wanted), cut: false }
  }
  if (at === 0) return { lines: split(decode(all)).slice(-wanted), cut: false }

  // Out of budget: the first line held is the tail end of a longer one.
  const lines = split(decode(all))
  lines[0] = `…${lines[0] ?? ''}`
  return { lines: lines.slice(-wanted), cut: true }
}

function present(from: 'start' | 'end', total: number, picked: Picked): string {
  const shown = picked.lines.length
  const first = from === 'end' ? total - shown + 1 : 1
  const body = picked.lines.map((line, at) => `${first + at}\t${clean(line)}`).join('\n')

  if (picked.cut) {
    return (
      `${body}\n(${total} in total; a line here is longer than ${MAX_BYTES} bytes, more than head ` +
      'reads, so what is shown is the part of it that fit)'
    )
  }
  if (shown >= total) return `${body}\n(the whole file: ${count(total, 'line', 'lines')})`
  if (from === 'end') {
    return `... ${count(total - shown, 'line before this', 'lines before these')} (${total} in total)\n${body}`
  }
  return `${body}\n... ${count(total - shown, 'more line', 'more lines')} (${total} in total)`
}

/** A line as shown: no carriage return, and no more than a screen of it. */
function clean(line: string): string {
  const bare = line.endsWith('\r') ? line.slice(0, -1) : line
  return bare.length > MAX_LINE_LENGTH ? `${bare.slice(0, MAX_LINE_LENGTH)}…` : bare
}

/** Lines of a text, where a final newline ends the last line rather than starting one. */
function split(text: string): string[] {
  const lines = text.split('\n')
  if (lines.length > 1 && lines[lines.length - 1] === '') lines.pop()
  return lines
}

function newlinesIn(bytes: Uint8Array): number {
  let count = 0
  for (let at = bytes.indexOf(NEWLINE); at !== -1; at = bytes.indexOf(NEWLINE, at + 1)) {
    count += 1
  }
  return count
}

/** Index of the nth newline from the start, or -1. */
function nthNewline(bytes: Uint8Array, nth: number): number {
  let at = -1
  for (let seen = 0; seen < nth; seen += 1) {
    at = bytes.indexOf(NEWLINE, at + 1)
    if (at === -1) return -1
  }
  return at
}

/** Index of the nth newline from the end, or -1. */
function newlineFromEnd(bytes: Uint8Array, nth: number): number {
  let at = bytes.length
  for (let seen = 0; seen < nth; seen += 1) {
    if (at === 0) return -1
    at = bytes.lastIndexOf(NEWLINE, at - 1)
    if (at === -1) return -1
  }
  return at
}

function concat(parts: Uint8Array[]): Uint8Array {
  if (parts.length === 1) return parts[0] as Uint8Array
  const all = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0))
  let at = 0
  for (const part of parts) {
    all.set(part, at)
    at += part.length
  }
  return all
}

function decode(bytes: Uint8Array): string {
  return new TextDecoder().decode(bytes)
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}
