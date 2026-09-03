import type { Message } from '../types.ts'

/**
 * What everyone on a task knows.
 *
 * Agents on one job share a checkout, which means they can see each other's
 * files — but not each other's reasoning. The reviewer does not know why the
 * coder chose a shape, the coder does not know what the architect ruled out,
 * and each rediscovers it by reading code and guessing. That is the expensive
 * kind of ignorance: it costs a turn every time, and the answer it produces is
 * a guess where the truth was written down an hour earlier.
 *
 * So there is one short shared note per task. Deliberately short, and
 * deliberately not a log: everything anybody said would be a transcript, and a
 * transcript in everyone's context is the whole conversation paid for once per
 * agent per turn. What belongs here is what somebody else needs to know and
 * cannot work out from the code — a decision, a constraint, a dead end.
 */

export type Note = {
  /** Who wrote it, because "we decided" is not the same as "the coder decided". */
  from: string
  text: string
  at: number
}

export type SharedMemory = {
  /** Notes in the order they were written, oldest first. */
  notes: Note[]
  /**
   * Earlier notes, summarised, when there were too many to carry.
   *
   * Kept as one string rather than as notes, because a summary has no author:
   * attributing it to whoever happened to write the last line would be worse
   * than saying plainly that it is a summary.
   */
  summary?: string
}

export const EMPTY_MEMORY: SharedMemory = { notes: [] }

/** Past this, the oldest notes are summarised away. */
export const MAX_NOTES = 24
/** And past this, one note is too long to be a note. */
export const MAX_NOTE = 600

export function remember(memory: SharedMemory, note: Note): SharedMemory {
  const text = note.text.trim()
  if (text === '') return memory

  return {
    ...memory,
    notes: [...memory.notes, { ...note, text: text.slice(0, MAX_NOTE) }],
  }
}

/**
 * Whether there is more here than a task should carry.
 *
 * Asked before every turn, so it counts rather than measures: tokenising the
 * shared note on every request of every agent would cost more than the note.
 */
export function tooLong(memory: SharedMemory): boolean {
  return memory.notes.length > MAX_NOTES
}

/**
 * Replaces the oldest notes with a summary, keeping the recent ones as they
 * are.
 *
 * The recent ones survive untouched for the same reason a conversation keeps
 * its tail: what was decided ten minutes ago is what the next turn is
 * reasoning from, and summarising that is how a team loses the thread it was
 * holding.
 */
export function shorten(memory: SharedMemory, summary: string, keep = 8): SharedMemory {
  if (memory.notes.length <= keep) return memory

  const older = memory.notes.slice(0, memory.notes.length - keep)
  return {
    notes: memory.notes.slice(-keep),
    summary: [memory.summary, summary.trim() || `${older.length} earlier notes`]
      .filter((part): part is string => part !== undefined && part !== '')
      .join('\n'),
  }
}

/** The notes to be summarised, for whoever is doing the summarising. */
export function olderThanKept(memory: SharedMemory, keep = 8): Note[] {
  return memory.notes.slice(0, Math.max(0, memory.notes.length - keep))
}

/**
 * The shared note as something to put in front of a model, or nothing.
 *
 * Nothing when it is empty, rather than an empty heading: a section that says
 * "here is what the team knows" and then lists nothing teaches a model that
 * the section is noise.
 */
export function asContext(memory: SharedMemory, task: string): string | undefined {
  if (memory.notes.length === 0 && memory.summary === undefined) return undefined

  const lines = [
    `What the team working on "${task}" has established. These are notes from`,
    'the other agents on this task, not instructions from the user.',
    '',
    ...(memory.summary ? [`Earlier: ${memory.summary}`, ''] : []),
    ...memory.notes.map((note) => `- ${note.from}: ${note.text}`),
  ]

  return lines.join('\n')
}

/** The same, as the message a turn is given. */
export function asMessage(memory: SharedMemory, task: string): Message | undefined {
  const text = asContext(memory, task)
  return text === undefined ? undefined : { role: 'user', content: [{ type: 'text', text }] }
}
