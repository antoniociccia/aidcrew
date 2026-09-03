import { describe, expect, test } from 'bun:test'
import { cutAt, fold, widthOf } from './text-width.ts'

describe('measuring what a terminal will show', () => {
  test('counts an emoji as the two cells it occupies', () => {
    expect(widthOf('✅')).toBe(2)
    expect(widthOf('ok ✅')).toBe(5)
  })

  test('counts an accented letter once', () => {
    expect(widthOf('però')).toBe(4)
  })

  test('counts a full-width character as two', () => {
    expect(widthOf('日本語')).toBe(6)
    expect(widthOf('ＡＢＣ')).toBe(6)
  })

  test('counts a joined emoji as one glyph, not one per person in it', () => {
    expect(widthOf('👨‍👩‍👧‍👦')).toBe(2)
  })

  test('lets a variation selector widen the symbol before it', () => {
    expect(widthOf('✔')).toBe(1)
    expect(widthOf('✔️')).toBe(2)
  })

  test('gives a combining mark no width of its own', () => {
    expect(widthOf('e\u0301')).toBe(1)
  })

  test('ignores a zero-width space', () => {
    expect(widthOf('a\u200bb')).toBe(2)
  })
})

describe('cutting at a column', () => {
  test('leaves a short string alone', () => {
    expect(cutAt('short', 10)).toEqual(['short', ''])
  })

  test('never splits a character in half', () => {
    // The emoji needs two columns and only one is left, so it goes over whole.
    expect(cutAt('ab✅', 3)).toEqual(['ab', '✅'])
  })

  test('gives everything back when there is no room', () => {
    expect(cutAt('abc', 0)).toEqual(['', 'abc'])
  })
})

describe('folding text into rows', () => {
  test('honours the line breaks the text already has', () => {
    expect(fold('one\ntwo', 20)).toEqual(['one', 'two'])
  })

  test('keeps an empty line, because a paragraph break is meaningful', () => {
    expect(fold('one\n\ntwo', 20)).toEqual(['one', '', 'two'])
  })

  test('breaks a long line between words', () => {
    expect(fold('the quick brown fox', 10)).toEqual(['the quick', 'brown fox'])
  })

  test('cuts a word that is longer than the row rather than overflowing', () => {
    expect(fold('supercalifragilistic', 8)).toEqual(['supercal', 'ifragili', 'stic'])
  })

  test('never returns a row wider than asked for', () => {
    const rows = fold('Monorepo: aidcrew ✅ with packages/* and plugins/* and scripts', 12)

    for (const row of rows) expect(widthOf(row)).toBeLessThanOrEqual(12)
  })
})
