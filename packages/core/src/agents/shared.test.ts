import { describe, expect, test } from 'bun:test'
import {
  asContext,
  asMessage,
  EMPTY_MEMORY,
  MAX_NOTES,
  olderThanKept,
  remember,
  shorten,
  tooLong,
} from './shared.ts'

const note = (from: string, text: string) => ({ from, text, at: 1 })

describe('what everyone on a task knows', () => {
  test('keeps notes in the order they were written, with who wrote them', () => {
    // "We decided" is not the same as "the coder decided", and an agent
    // reading this needs to know which.
    let memory = remember(EMPTY_MEMORY, note('architect', 'auth stays in the guard'))
    memory = remember(memory, note('coder', 'the rotation is in token.ts, not guard.ts'))

    expect(memory.notes.map((entry) => entry.from)).toEqual(['architect', 'coder'])
  })

  test('ignores an empty note rather than keeping an empty line', () => {
    expect(remember(EMPTY_MEMORY, note('coder', '   ')).notes).toEqual([])
  })

  test('cuts a note that is too long to be a note', () => {
    const long = remember(EMPTY_MEMORY, note('coder', 'x'.repeat(2000)))

    expect(long.notes[0]?.text.length).toBeLessThanOrEqual(600)
  })
})

describe('putting it in front of a model', () => {
  test('says whose notes these are, and that they are not instructions', () => {
    // An agent that reads a colleague's note as an order from the user will
    // do what the note describes instead of what it was asked.
    const memory = remember(EMPTY_MEMORY, note('architect', 'do not touch loop.ts'))

    const context = asContext(memory, 'auth') ?? ''
    expect(context).toContain('not instructions from the user')
    expect(context).toContain('- architect: do not touch loop.ts')
    expect(context).toContain('"auth"')
  })

  test('is nothing at all when nothing has been established', () => {
    // A section that says "here is what the team knows" and lists nothing
    // teaches a model that the section is noise.
    expect(asContext(EMPTY_MEMORY, 'auth')).toBeUndefined()
    expect(asMessage(EMPTY_MEMORY, 'auth')).toBeUndefined()
  })
})

describe('when there is more than a task should carry', () => {
  const many = Array.from({ length: MAX_NOTES + 5 }, (_, at) =>
    note('coder', `finding number ${at}`),
  ).reduce(remember, EMPTY_MEMORY)

  test('notices, by counting rather than by measuring', () => {
    // Tokenising this before every request of every agent would cost more
    // than the note it is protecting.
    expect(tooLong(many)).toBe(true)
    expect(tooLong(EMPTY_MEMORY)).toBe(false)
  })

  test('hands over exactly the notes that would be summarised', () => {
    const older = olderThanKept(many, 8)

    expect(older).toHaveLength(many.notes.length - 8)
    expect(older.at(-1)?.text).toBe(`finding number ${many.notes.length - 9}`)
  })

  test('keeps the recent ones untouched and summarises the rest', () => {
    // What was decided ten minutes ago is what the next turn reasons from,
    // and summarising that is how a team loses the thread it was holding.
    const shorter = shorten(many, 'the team agreed on the guard shape', 8)

    expect(shorter.notes).toHaveLength(8)
    expect(shorter.notes.at(-1)?.text).toBe(`finding number ${many.notes.length - 1}`)
    expect(shorter.summary).toBe('the team agreed on the guard shape')
  })

  test('a second summary is added to the first, not written over it', () => {
    const once = shorten(many, 'first round', 8)
    const twice = shorten({ ...once, notes: many.notes }, 'second round', 8)

    expect(twice.summary).toContain('first round')
    expect(twice.summary).toContain('second round')
  })

  test('says how many were dropped when the summariser said nothing', () => {
    // A summary that failed leaves a count rather than a silence, so nobody
    // reads a shortened note as a complete one.
    expect(shorten(many, '   ', 8).summary).toMatch(/earlier notes/)
  })

  test('shortening a short memory changes nothing', () => {
    const small = remember(EMPTY_MEMORY, note('coder', 'one thing'))

    expect(shorten(small, 'summary', 8)).toEqual(small)
  })
})
