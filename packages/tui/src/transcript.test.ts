import { describe, expect, test } from 'bun:test'
import type { Entry } from './transcript.ts'
import { pagesOf, toRows } from './transcript.ts'

const say = (text: string): Entry => ({ kind: 'say', text })

describe('laying a transcript into a pane', () => {
  test('gives one row to a message that fits', () => {
    expect(toRows([say('hello')], 20, 10)).toEqual([{ kind: 'say', text: 'hello', first: true }])
  })

  test('spreads a message with line breaks over as many rows as it has', () => {
    // The bug this exists for: these three lines used to be drawn as one row,
    // and the other two landed outside the pane, on top of the key hints.
    const rows = toRows([say('Monorepo: aidcrew\nStacks: packages, plugins\nReady.')], 40, 10)

    expect(rows.map((row) => row.text)).toEqual([
      'Monorepo: aidcrew',
      'Stacks: packages, plugins',
      'Ready.',
    ])
  })

  test('marks only the first row of a message, since the rest carry no marker', () => {
    const rows = toRows([say('one\ntwo')], 40, 10)

    expect(rows.map((row) => row.first)).toEqual([true, false])
  })

  test('leaves room for the marker when folding', () => {
    const rows = toRows([say('abcdefghij')], 7, 10)

    expect(rows.map((row) => row.text)).toEqual(['abcde', 'fghij'])
  })

  test('never returns more rows than the pane has', () => {
    const rows = toRows([say('a\nb\nc\nd\ne')], 20, 3)

    expect(rows).toHaveLength(3)
  })

  test('keeps the end of the conversation, not the beginning', () => {
    const rows = toRows([say('first'), say('second'), say('third')], 20, 2)

    expect(rows.map((row) => row.text)).toEqual(['second', 'third'])
  })

  test('gives nothing for a pane with no room', () => {
    expect(toRows([say('hello')], 20, 0)).toEqual([])
  })
})

describe('paging back through what was said', () => {
  const history = Array.from({ length: 10 }, (_, at) => say(`line ${at}`))

  test('shows the newest rows on the first page', () => {
    expect(toRows(history, 20, 3).map((row) => row.text)).toEqual(['line 7', 'line 8', 'line 9'])
  })

  test('shows the page before it one back', () => {
    expect(toRows(history, 20, 3, 1).map((row) => row.text)).toEqual(['line 4', 'line 5', 'line 6'])
  })

  test('keeps going back a whole page at a time', () => {
    expect(toRows(history, 20, 3, 2).map((row) => row.text)).toEqual(['line 1', 'line 2', 'line 3'])
  })

  test('runs out at the beginning rather than inventing rows', () => {
    const rows = toRows(history, 20, 3, 9)

    expect(rows.length).toBeLessThanOrEqual(3)
    expect(rows[0]?.text).toBe('line 0')
  })

  test('counts the pages there are to go back through', () => {
    expect(pagesOf(history, 20, 3)).toBe(3)
    expect(pagesOf(history, 20, 10)).toBe(0)
  })

  test('counts a folded message by the rows it really takes', () => {
    // Two entries, but one of them is four rows tall.
    const tall = [say('a\nb\nc\nd'), say('e')]

    expect(pagesOf(tall, 20, 2)).toBe(2)
  })

  test('has no pages to go back through when there is nothing', () => {
    expect(pagesOf([], 20, 5)).toBe(0)
  })
})

describe('folding the same message twice', () => {
  test('gives back the very same rows, rather than folding it again', () => {
    // Counting the pages and drawing one both walk the whole history, and
    // folding four thousand messages on every frame is what made scrolling
    // back through a long session feel like wading. Nothing said is ever
    // edited, so a message folded at a width folds the same way forever.
    const entry = say('a message long enough to need folding across several rows here')

    const first = toRows([entry], 20, 10)
    const second = toRows([entry], 20, 10)

    expect(second.map((row) => row.text)).toEqual(first.map((row) => row.text))
  })

  test('folds it again when the window changes width', () => {
    const entry = say('a message long enough to need folding across several rows here')

    const narrow = toRows([entry], 20, 10)
    const wide = toRows([entry], 60, 10)

    expect(wide.length).toBeLessThan(narrow.length)
  })

  test('counting and drawing agree about how tall a message is', () => {
    // They read the same cache, so a page that says it exists can be reached.
    const history = Array.from({ length: 40 }, (_, at) => say(`line ${at}\nand more`))

    const pages = pagesOf(history, 30, 10)
    const oldest = toRows(history, 30, 10, pages)

    expect(oldest[0]?.text).toBe('line 0')
  })
})
