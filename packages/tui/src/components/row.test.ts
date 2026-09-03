import { describe, expect, test } from 'bun:test'
import { clip, coalesce, compose, measure, split } from './row.ts'

describe('composing a tinted row', () => {
  test('pads out to the full width, so the tint reaches the edge', () => {
    const row = compose(10, [{ text: 'coder' }])

    expect(measure(row)).toBe(10)
  })

  test('pushes the right side against the edge', () => {
    const row = compose(12, [{ text: 'coder' }], [{ text: '8.0k' }])

    expect(row.map((segment) => segment.text).join('')).toBe('coder   8.0k')
  })

  test('takes the room out of the left side, which is the repeated part', () => {
    const row = compose(10, [{ text: 'a-very-long-agent' }], [{ text: '9k' }])

    expect(measure(row)).toBe(10)
    expect(row.map((segment) => segment.text).join('')).toBe('a-very-…9k')
  })

  test('keeps the colours of the segments it fits', () => {
    const row = compose(20, [
      { text: 'coder', color: '#fff', bold: true },
      { text: ' idle', color: '#888' },
    ])

    expect(row[0]).toEqual({ text: 'coder', color: '#fff', bold: true })
    expect(row[1]).toEqual({ text: ' idle', color: '#888' })
  })

  test('says when it cut something rather than reading as a shorter name', () => {
    expect(
      clip([{ text: 'reviewer' }], 5)
        .map((s) => s.text)
        .join(''),
    ).toBe('revi…')
  })

  test('counts a wide character once, not once per code unit', () => {
    expect(measure([{ text: '▁▂▅' }])).toBe(3)
  })

  test('gives nothing at all for no room', () => {
    expect(compose(0, [{ text: 'coder' }])).toEqual([])
  })
})

describe('filling part of a row', () => {
  test('cuts between segments when the position falls on a boundary', () => {
    const [before, after] = split([{ text: 'ab' }, { text: 'cd' }], 2)

    expect(before).toEqual([{ text: 'ab' }])
    expect(after).toEqual([{ text: 'cd' }])
  })

  test('splits a segment in the middle, keeping its colour on both sides', () => {
    const [before, after] = split([{ text: 'opus-5', color: '#fff' }], 3)

    expect(before).toEqual([{ text: 'opu', color: '#fff' }])
    expect(after).toEqual([{ text: 's-5', color: '#fff' }])
  })

  test('fills nothing at zero, which is an agent that has done nothing', () => {
    expect(split([{ text: 'abc' }], 0)).toEqual([[], [{ text: 'abc' }]])
  })

  test('fills everything past the end rather than dropping the rest', () => {
    const [before, after] = split([{ text: 'abc' }], 99)

    expect(before).toEqual([{ text: 'abc' }])
    expect(after).toEqual([])
  })
})

describe('joining segments that look alike', () => {
  test('merges a run of identical styling into one', () => {
    const merged = coalesce([
      { text: 'ab', color: '#fff' },
      { text: 'cd', color: '#fff' },
      { text: 'ef', color: '#000' },
    ])

    expect(merged).toEqual([
      { text: 'abcd', color: '#fff' },
      { text: 'ef', color: '#000' },
    ])
  })

  test('keeps bold apart from plain, which are not the same styling', () => {
    const merged = coalesce([
      { text: 'a', color: '#fff', bold: true },
      { text: 'b', color: '#fff' },
    ])

    expect(merged).toHaveLength(2)
  })

  test('drops empty segments, which draw nothing and cost an element', () => {
    expect(coalesce([{ text: '' }, { text: 'a' }])).toEqual([{ text: 'a' }])
  })

  test('does not write back to the segments it was given', () => {
    const original = [{ text: 'ab' }, { text: 'cd' }]
    coalesce(original)

    expect(original[0]).toEqual({ text: 'ab' })
  })
})

describe('keeping a row to one row', () => {
  test('turns a line break into a space rather than a second row', () => {
    // A status cell showing what an agent said used to split in two here, and
    // every cell after it slid out of its column.
    const row = compose(24, [{ text: 'Quick orientation\non this repo' }])

    expect(row.map((segment) => segment.text).join('')).not.toContain('\n')
  })

  test('drops escape sequences, which would paint outside the row', () => {
    const row = compose(20, [{ text: 'red \u001b[31mhere' }])

    expect(row.map((segment) => segment.text).join('')).toBe('red [31mhere        ')
  })

  test('measures what is left after flattening, not the raw text', () => {
    const row = compose(10, [{ text: 'a\nb' }])

    expect(measure(row)).toBe(10)
  })
})
