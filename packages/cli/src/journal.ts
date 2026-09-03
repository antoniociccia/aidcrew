import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import type { Message, Usage } from '@aidcrew/core'

/**
 * The session record, as a file you can read.
 *
 * One line per thing that happened, appended when it happens. That is the
 * whole design, and it is chosen over a database for a reason measured rather
 * than assumed: keeping the conversation as a row to rewrite costs more with
 * every turn — 0.11ms at turn ten and 1.31ms at turn two hundred, because the
 * whole conversation is written again each time — while appending what is new
 * costs 0.05ms whatever came before. On disk it is half the size.
 *
 * The bug it removes is the better argument. A row that is rewritten has a
 * moment when it has not been written yet, and a turn that fails never gets
 * there: an agent that worked all afternoon and ended on a provider error had
 * nothing kept, and came back not knowing it had ever been asked anything.
 * There is no such moment here. What happened is on disk because it happened.
 *
 * Kept under the user's home rather than in the project, because a transcript
 * is a record of what somebody did and not a property of the repository —
 * it changes on every run, it holds tool output and the contents of files
 * that were read, and it has no business in a checkout at all.
 */

export type Line = { agentId: string; kind: string; text: string }

/** One line of the file. Anything unknown is skipped rather than fatal. */
type Entry =
  | { type: 'line'; agentId: string; kind: string; text: string; at: number }
  | { type: 'message'; agentId: string; message: Message; at: number }
  | { type: 'usage'; agentId: string; usage: Usage; at: number }
  /** What a whole job has cost, which is the figure anybody actually asks for. */
  | { type: 'task-usage'; taskId: string; usage: Usage; at: number }
  /**
   * The conversation from here, in full.
   *
   * Written when what an agent holds is no longer what was appended — after
   * compaction, which replaces old exchanges with a summary. Rare, and the
   * only entry that is not a delta: a summary is not something that was said.
   */
  | { type: 'replaced'; agentId: string; messages: Message[]; at: number }
  | { type: 'forgotten'; agentId: string; at: number }

export type Journal = {
  /** The file everything is written to, for anyone who wants to read it. */
  path: string
  transcript(): Line[]
  append(line: Line): void
  messages(agentId: string): Message[]
  usageOf(agentId: string): Usage | undefined
  /**
   * What a whole task has cost, across every agent that worked on it.
   *
   * Kept apart from the per-agent totals rather than added up on demand: an
   * agent can be killed and its total go with it while the job carries on,
   * and "what did this piece of work cost" is the question people ask.
   */
  usageOfTask(taskId: string): Usage | undefined
  /** Records what a task has spent so far. */
  rememberTask(taskId: string, usage: Usage): void
  /**
   * Records where an agent's conversation now stands.
   *
   * Takes the whole conversation because that is what the caller has, and
   * writes only what is new: the common case is two more messages on the end,
   * and appending two lines is the point of all this. When the new
   * conversation is not the old one with more on the end — which means it was
   * compacted — the whole thing is written once, marked as a replacement.
   */
  remember(agentId: string, messages: Message[], usage?: Usage): void
  forget(agentId: string): void
  close(): void
}

/**
 * Where a project's record lives, named after the path it belongs to.
 *
 * The name written today carries a hash and the one written before did not,
 * and a record is where somebody's afternoon went: changing how the folder is
 * named must not leave every existing one behind. So the older name is tried
 * first, and used when the note beside it says this project — only then,
 * because the older name is exactly the one two projects could share.
 */
export function journalPath(cwd: string, home = homedir()): string {
  const project = resolve(cwd)
  const records = join(home, '.aidcrew', 'projects')
  const older = join(records, dashed(project))
  if (belongsTo(older, project)) return join(older, 'session.jsonl')
  return join(records, slugOf(project), 'session.jsonl')
}

/**
 * A directory name that says which project it is, and says it for one project.
 *
 * The path with its separators turned into dashes, readable enough that
 * somebody looking in the folder can tell which project a record belongs to
 * without opening it — followed by a few characters of a hash of the path,
 * which is what makes the name belong to one project. The dashes alone did
 * not: `/x/dev-tools` and `/x/dev/tools` became the same folder, so project
 * B's agent came up holding project A's conversation and the files A had
 * read, and deleting B took A's record with it.
 */
export function slugOf(cwd: string): string {
  const project = resolve(cwd)
  const hash = createHash('sha1').update(project).digest('hex').slice(0, 8)
  return `${dashed(project)}-${hash}`
}

function dashed(path: string): string {
  return path.replace(/[/\\:]/g, '-')
}

/** Whether the note beside a record names this project. */
function belongsTo(record: string, project: string): boolean {
  try {
    return readFileSync(join(record, 'path'), 'utf8').trim() === project
  } catch {
    return false
  }
}

export function openJournal(cwd: string, home = homedir()): Journal {
  const path = journalPath(cwd, home)
  mkdirSync(dirname(path), { recursive: true })
  // Written down because the directory name cannot be read back: `slugOf`
  // turns separators into dashes, and a project whose own name has a dash in
  // it reconstructs to a different path — or to one that happens to exist.
  // Without this, nothing can tell a record whose project is gone from one
  // whose is not, and these hold tool output and the contents of files that
  // were read.
  try {
    writeFileSync(join(dirname(path), 'path'), resolve(cwd))
  } catch {
    // A record that cannot say where it came from is still a usable record.
  }
  // The record holds tool output and the contents of files that were read.
  try {
    mkdirSync(join(home, '.aidcrew'), { recursive: true, mode: 0o700 })
  } catch {
    // An existing directory with other permissions is the user's business.
  }

  const entries = read(path)
  let closed = false

  /** What each agent's conversation is now, so only the tail is written. */
  const held = new Map<string, Message[]>()
  const spent = new Map<string, Usage>()
  const byTask = new Map<string, Usage>()
  const lines: Line[] = []
  replay(entries, { held, spent, byTask, lines })

  function write(entry: Entry): void {
    if (closed) return
    appendFileSync(path, `${JSON.stringify(entry)}\n`)
  }

  return {
    path,

    transcript: () => [...lines],

    append(line) {
      lines.push(line)
      write({ type: 'line', ...line, at: Date.now() })
    },

    messages: (agentId) => [...(held.get(agentId) ?? [])],

    usageOf: (agentId) => spent.get(agentId),

    usageOfTask: (taskId) => byTask.get(taskId),

    rememberTask(taskId, usage) {
      // Only when it moved. This is asked on every redraw of the tasks
      // screen, and writing every answer put sixteen identical lines on the
      // record in seven seconds.
      const before = byTask.get(taskId)
      if (before && JSON.stringify(before) === JSON.stringify(usage)) return
      byTask.set(taskId, usage)
      write({ type: 'task-usage', taskId, usage, at: Date.now() })
    },

    remember(agentId, messages, usage) {
      const before = held.get(agentId) ?? []
      const grew = messages.length >= before.length && sameStart(before, messages)

      if (grew) {
        for (const message of messages.slice(before.length)) {
          write({ type: 'message', agentId, message, at: Date.now() })
        }
      } else {
        // Compacted, or otherwise not what was there before. Written whole,
        // once, and marked so replay knows to start again from here.
        write({ type: 'replaced', agentId, messages, at: Date.now() })
      }

      held.set(agentId, [...messages])

      if (usage) {
        spent.set(agentId, usage)
        write({ type: 'usage', agentId, usage, at: Date.now() })
      }
    },

    forget(agentId) {
      held.delete(agentId)
      spent.delete(agentId)
      // What was on the screen, as well as what the model remembered. This
      // dropped only the conversation, so the word cleared what you could not
      // see and kept what you could — and then a note was added on top,
      // making the visible result of it a longer transcript.
      for (let at = lines.length - 1; at >= 0; at--) {
        if (lines[at]?.agentId === agentId) lines.splice(at, 1)
      }
      write({ type: 'forgotten', agentId, at: Date.now() })
    },

    close() {
      closed = true
    },
  }
}

/** Whether `whole` begins with `start`, message for message. */
function sameStart(start: Message[], whole: Message[]): boolean {
  for (const [at, message] of start.entries()) {
    if (JSON.stringify(message) !== JSON.stringify(whole[at])) return false
  }
  return true
}

function read(path: string): Entry[] {
  let text: string
  try {
    text = readFileSync(path, 'utf8')
  } catch {
    return []
  }

  const entries: Entry[] = []
  for (const line of text.split('\n')) {
    if (line.trim() === '') continue
    try {
      entries.push(JSON.parse(line) as Entry)
    } catch {
      // A line cut in half by a machine losing power. Everything before it is
      // still good, which is the whole reason for writing this way.
    }
  }
  return entries
}

/** Builds the current state by playing the file back in order. */
function replay(
  entries: Entry[],
  into: {
    held: Map<string, Message[]>
    spent: Map<string, Usage>
    byTask: Map<string, Usage>
    lines: Line[]
  },
): void {
  for (const entry of entries) {
    if (entry.type === 'line') {
      into.lines.push({ agentId: entry.agentId, kind: entry.kind, text: entry.text })
      continue
    }
    if (entry.type === 'message') {
      into.held.set(entry.agentId, [...(into.held.get(entry.agentId) ?? []), entry.message])
      continue
    }
    if (entry.type === 'replaced') {
      into.held.set(entry.agentId, [...entry.messages])
      continue
    }
    if (entry.type === 'usage') {
      into.spent.set(entry.agentId, entry.usage)
      continue
    }
    if (entry.type === 'task-usage') {
      into.byTask.set(entry.taskId, entry.usage)
      continue
    }
    if (entry.type === 'forgotten') {
      into.held.delete(entry.agentId)
      into.spent.delete(entry.agentId)
      // The transcript goes with the conversation. Kept, it came back the
      // next time the session opened — so `/clear` cleared the screen until
      // you reopened, which is the same as not having cleared it.
      for (let at = into.lines.length - 1; at >= 0; at--) {
        if (into.lines[at]?.agentId === entry.agentId) into.lines.splice(at, 1)
      }
    }
  }
}

/**
 * Rewrites the file without one agent's entries.
 *
 * The only operation append-only cannot express, and it is worth the
 * exception: a killed agent's conversation should not be replayed forever,
 * and a file that only grows is a file somebody eventually deletes by hand.
 * Written beside the original and moved into place, so a machine that stops
 * halfway leaves the old file intact rather than half a new one.
 */
export function compactJournal(path: string, keep: (agentId: string) => boolean): void {
  // A task's total is nobody's agent, and outlives every agent that produced
  // it: what a piece of work cost stays true after the agents are gone.
  const kept = read(path).filter((entry) => entry.type === 'task-usage' || keep(entry.agentId))
  const temporary = `${path}.rewriting`
  writeFileSync(temporary, kept.map((entry) => `${JSON.stringify(entry)}\n`).join(''))
  renameSync(temporary, path)
}

/**
 * Brings across what an earlier version kept in a database beside the project.
 *
 * Once, and only into an empty record: a project opened twice should not have
 * its old transcript twice. The database is left where it is rather than
 * deleted — somebody who wants it gone can say so, and losing a record while
 * changing how records are kept would be the worst possible moment.
 */
export function importDatabase(
  journal: Journal,
  older: {
    transcript(): Line[]
    messages(agentId: string): Message[]
    usageOf?(agentId: string): Usage | undefined
  },
): number {
  if (journal.transcript().length > 0) return 0

  const lines = older.transcript()
  for (const line of lines) journal.append(line)

  for (const agentId of new Set(lines.map((line) => line.agentId))) {
    const messages = older.messages(agentId)
    if (messages.length > 0) journal.remember(agentId, messages, older.usageOf?.(agentId))
  }

  return lines.length
}

/**
 * Session records whose project is no longer on disk.
 *
 * They accumulate: every directory ever opened leaves one, nothing shows them,
 * and nothing has ever taken one away. What is in them is the reason to care —
 * the transcript holds tool output and the contents of files that were read,
 * so a record for a project you deleted is a copy of that project's files
 * sitting in your home directory indefinitely.
 *
 * Records written before this was kept say nothing about where they came from
 * and are left alone. Guessing from the folder name is what this exists to
 * stop doing.
 */
export function orphanedRecords(home = homedir()): { slug: string; cwd: string }[] {
  const root = join(home, '.aidcrew', 'projects')
  let slugs: string[]
  try {
    slugs = readdirSync(root)
  } catch {
    return []
  }

  const orphans: { slug: string; cwd: string }[] = []
  for (const slug of slugs) {
    let cwd: string
    try {
      cwd = readFileSync(join(root, slug, 'path'), 'utf8').trim()
    } catch {
      continue
    }
    if (cwd !== '' && !existsSync(cwd)) orphans.push({ slug, cwd })
  }
  return orphans
}
