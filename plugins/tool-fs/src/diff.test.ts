import { describe, expect, test } from 'bun:test'
import { changeOf, type FileChange, rangesOf, render } from './diff.ts'

/** The tests read better when the thing under test is never `undefined`. */
function changed(path: string, before: string, after: string): FileChange {
  const change = changeOf(path, before, after)
  if (change === undefined) throw new Error('expected a change')
  return change
}

describe('changeOf', () => {
  test('says nothing changed when nothing did', () => {
    expect(changeOf('a.ts', 'one\n', 'one\n')).toBeUndefined()
  })

  test('counts what a replacement added and removed', () => {
    const change = changed('a.ts', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')

    expect(change.added).toBe(1)
    expect(change.removed).toBe(1)
    expect(change.hunks).toHaveLength(1)
  })

  test('keeps two lines of context around a change', () => {
    const before = Array.from({ length: 20 }, (_, at) => `L${at + 1}`).join('\n')
    const after = before.replace('L10', 'CHANGED')

    const hunk = changed('a.ts', before, after).hunks[0]

    expect(hunk?.newStart).toBe(8)
    expect(hunk?.newLines).toEqual(['L8', 'L9', 'CHANGED', 'L11', 'L12'])
    expect(hunk?.oldLines).toEqual(['L8', 'L9', 'L10', 'L11', 'L12'])
  })

  test('two changes far apart are two hunks', () => {
    const before = Array.from({ length: 40 }, (_, at) => `L${at + 1}`).join('\n')
    const after = before.replace('L3', 'THREE').replace('L30', 'THIRTY')

    expect(changed('a.ts', before, after).hunks).toHaveLength(2)
  })

  test('two changes close together are one hunk, not two touching ones', () => {
    const before = Array.from({ length: 20 }, (_, at) => `L${at + 1}`).join('\n')
    const after = before.replace('L10', 'TEN').replace('L12', 'TWELVE')

    expect(changed('a.ts', before, after).hunks).toHaveLength(1)
  })

  test('a file that did not exist is all additions', () => {
    const change = changed('new.ts', '', 'hello\n')

    expect(change.created).toBe(true)
    expect(change.added).toBe(1)
    expect(change.removed).toBe(0)
  })

  test('a trailing newline does not become a phantom line', () => {
    expect(changeOf('a.ts', 'one', 'one\n')).toBeUndefined()
  })

  test('a carriage return is not a change of every line', () => {
    expect(changed('a.ts', 'one\r\ntwo\r\n', 'one\r\nTWO\r\n').added).toBe(1)
  })

  test('a deletion is a hunk with nothing on the new side', () => {
    const change = changed('a.ts', 'one\ntwo\nthree\n', 'one\nthree\n')

    expect(change.removed).toBe(1)
    expect(change.added).toBe(0)
  })
})

describe('render', () => {
  test('names the file and what it cost', () => {
    const rendered = render(changed('src/rates.ts', 'one\ntwo\n', 'one\nTWO\n'))

    expect(rendered.split('\n')[0]).toBe('~ src/rates.ts +1 -1')
  })

  test('marks every row, so the painter needs no column arithmetic', () => {
    const rows = render(changed('a.ts', 'one\ntwo\n', 'one\nTWO\n')).split('\n')

    expect(rows.every((row) => '~+- …'.includes(row.slice(0, 1)))).toBe(true)
    expect(rows).toContain('- 2 two')
    expect(rows).toContain('+ 2 TWO')
  })

  test('numbers a context row by where it is in the file now', () => {
    const before = Array.from({ length: 20 }, (_, at) => `L${at + 1}`).join('\n')
    const rows = render(changed('a.ts', before, before.replace('L10', 'TEN'))).split('\n')

    expect(rows).toContain('  8 L8')
    expect(rows).toContain('+ 10 TEN')
  })

  test('caps a large change and says how much it left out', () => {
    const after = Array.from({ length: 200 }, (_, at) => `L${at + 1}`).join('\n')

    const rendered = render(changed('big.ts', '', after))

    expect(rendered.split('\n').length).toBeLessThanOrEqual(14)
    expect(rendered).toContain('more lines')
    expect(rendered.split('\n').at(-1)?.startsWith('…')).toBe(true)
  })

  test('caps the number of hunks as well as their length', () => {
    const before = Array.from({ length: 200 }, (_, at) => `L${at + 1}`).join('\n')
    const after = before
      .replace('L10', 'A')
      .replace('L60', 'B')
      .replace('L110', 'C')
      .replace('L160', 'D')

    const rendered = render(changed('a.ts', before, after))

    expect(rendered.split('\n').filter((row) => row.startsWith('~'))).toHaveLength(1)
    expect(rendered).toContain('more lines')
  })
})

describe('rangesOf', () => {
  test('gives the lines of the new file a hunk covers', () => {
    const change = changed('a.ts', 'one\ntwo\nthree\n', 'one\nTWO\nthree\n')

    expect(rangesOf(change)).toEqual([[1, 3]])
  })

  test('a deletion still names where it happened', () => {
    const change = changed('a.ts', 'one\ntwo\nthree\nfour\n', 'one\nthree\nfour\n')

    expect(rangesOf(change)).toEqual([[1, 3]])
  })
})
