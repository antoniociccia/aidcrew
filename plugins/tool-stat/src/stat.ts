import type { Dirent, Stats } from 'node:fs'
import { type FileHandle, open, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { defineTool } from '@aidcrew/plugin-sdk'
import { explainMissing, resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'

/**
 * What a path is, before anything reads it.
 *
 * An agent that wants to know whether a file is worth opening has had one
 * way to find out: open it. Watched, that is a 900 KB lockfile arriving in
 * the context window so the model can learn it is a 900 KB lockfile. This
 * answers the question a `stat` call and an 8 KB glance can answer — size,
 * lines, text or binary, age — and for a directory, how much is in it.
 */

/** Never counted: never the answer, and .aidcrew holds whole second checkouts. */
const SKIPPED = new Set(['node_modules', '.git', 'dist', '.aidcrew'])
/** What is looked at to decide text from binary: the first 8 KB, like every other tool. */
const SNIFF = 8_192
const CHUNK = 65_536
/** Past this, counting lines takes longer than it is worth, and the size is the answer. */
const MAX_COUNTED = 50_000_000
/** Enough entries to size any package; a bound so `stat .` on a monorepo stays cheap. */
const MAX_ENTRIES = 20_000

export const statTool = defineTool({
  name: 'stat',
  reads: true,
  description:
    'Describe a path without reading it: for a file its size, line count, whether it is text ' +
    'or binary, and when it last changed; for a directory how many files and directories it ' +
    'holds. Use it before read on anything that might be large or generated, such as a lockfile.',
  schema: z.object({
    path: z.string().describe('File or directory, relative to the workspace.'),
  }),
  async run({ path }, { cwd }) {
    const resolved = resolveInWorkspace(cwd, path)

    let info: Stats
    try {
      info = await stat(resolved)
    } catch {
      return { content: explainMissing(cwd, path) ?? `${path} does not exist`, isError: true }
    }

    const changed = `changed ${ago(Date.now() - info.mtimeMs)} (${info.mtime.toISOString().replace(/\.\d{3}Z$/, 'Z')})`

    if (info.isDirectory()) {
      const held = await countEntries(resolved, MAX_ENTRIES)
      const about = held.stopped ? 'at least ' : ''
      const skipped = held.stopped
        ? `node_modules, .git, dist and .aidcrew not counted; stopped counting at ${MAX_ENTRIES} entries`
        : 'node_modules, .git, dist and .aidcrew not counted'
      return {
        content:
          `${path}: directory, ${about}${count(held.files, 'file', 'files')}, ` +
          `${about}${count(held.directories, 'directory', 'directories')} (${skipped}), ${changed}`,
      }
    }

    if (info.size === 0) return { content: `${path}: empty file, 0 bytes, ${changed}` }

    const handle = await open(resolved, 'r')
    try {
      if ((await sniff(handle, info.size)) === 'binary') {
        return { content: `${path}: binary, ${formatSize(info.size)}, ${changed}` }
      }
      const lines =
        info.size > MAX_COUNTED
          ? `lines not counted (over ${formatSize(MAX_COUNTED)})`
          : count(await countLines(handle, info.size), 'line', 'lines')
      return { content: `${path}: text, ${formatSize(info.size)}, ${lines}, ${changed}` }
    } finally {
      await handle.close()
    }
  },
})

/**
 * Text or binary, from the first 8 KB: a NUL byte or bytes that are not
 * UTF-8 mean binary. A window that ends inside a multibyte character is not
 * invalid, only cut short, so up to three dangling bytes are forgiven.
 */
async function sniff(handle: FileHandle, size: number): Promise<'text' | 'binary'> {
  const window = new Uint8Array(Math.min(SNIFF, size))
  const { bytesRead } = await handle.read(window, 0, window.length, 0)
  const bytes = window.subarray(0, bytesRead)

  if (bytes.includes(0)) return 'binary'

  const whole = bytesRead >= size
  for (let dangling = 0; dangling <= (whole ? 0 : 3); dangling += 1) {
    if (isUtf8(bytes.subarray(0, bytes.length - dangling))) return 'text'
  }
  return 'binary'
}

function isUtf8(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/** Lines, counted a chunk at a time so a large file never sits in memory whole. */
async function countLines(handle: FileHandle, size: number): Promise<number> {
  const chunk = new Uint8Array(Math.min(CHUNK, size))
  let lines = 0
  let last = 0

  for (let at = 0; at < size; ) {
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, at)
    if (bytesRead === 0) break
    for (
      let nl = chunk.indexOf(0x0a);
      nl !== -1 && nl < bytesRead;
      nl = chunk.indexOf(0x0a, nl + 1)
    ) {
      lines += 1
    }
    last = chunk[bytesRead - 1] as number
    at += bytesRead
  }
  // A last line with no newline after it is still a line.
  return last === 0x0a ? lines : lines + 1
}

/**
 * How many files and directories a directory holds, skipping the names nobody
 * means and stopping at `limit` so the answer for a whole monorepo is still
 * quick. Symlinks are counted as files and not followed.
 */
export async function countEntries(
  dir: string,
  limit: number,
): Promise<{ files: number; directories: number; stopped: boolean }> {
  const tally = { files: 0, directories: 0, stopped: false }
  const queue = [dir]

  for (let next = 0; next < queue.length; next += 1) {
    const current = queue[next] as string
    let entries: Dirent[]
    try {
      entries = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (SKIPPED.has(entry.name)) continue
      if (tally.files + tally.directories >= limit) {
        tally.stopped = true
        return tally
      }
      if (entry.isDirectory()) {
        tally.directories += 1
        queue.push(join(current, entry.name))
      } else {
        tally.files += 1
      }
    }
  }
  return tally
}

/** How long ago, in the units a person would pick. */
export function ago(elapsed: number): string {
  const seconds = Math.floor(elapsed / 1000)
  if (seconds < 45) return 'just now'

  const minutes = Math.max(1, Math.floor(seconds / 60))
  if (minutes < 60) return count(minutes, 'minute ago', 'minutes ago')
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return count(hours, 'hour ago', 'hours ago')
  const days = Math.floor(hours / 24)
  if (days < 30) return count(days, 'day ago', 'days ago')
  const months = Math.floor(days / 30)
  if (months < 12) return count(months, 'month ago', 'months ago')
  return count(Math.floor(days / 365), 'year ago', 'years ago')
}

/** The exact byte count, and past a kilobyte the same in units a person reads. */
export function formatSize(bytes: number): string {
  const exact = `${bytes.toLocaleString('en-US')} ${bytes === 1 ? 'byte' : 'bytes'}`
  if (bytes < 1024) return exact

  const units = ['KB', 'MB', 'GB', 'TB']
  let value = bytes / 1024
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${exact} (${value >= 100 ? value.toFixed(0) : value.toFixed(1)} ${units[unit]})`
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}
