import { describe, expect, test } from 'bun:test'
import { depthOf, indexOf, paint } from './paint.ts'

const ESC = '\u001b'
const colour = { FORCE_COLOR: '3' }
const plain = { NO_COLOR: '1' }

describe('painting rows', () => {
  test('writes the text plainly when colour is off', () => {
    const out = paint([{ segments: [{ text: 'a' }] }, { segments: [{ text: 'b' }] }], plain)

    expect(out).toBe('a\nb')
  })

  test('opens and closes the row background around the whole row', () => {
    const out = paint([{ background: '#1e1e23', segments: [{ text: 'hi' }] }], colour)

    expect(out).toBe(`${ESC}[48;2;30;30;35mhi${ESC}[49m`)
  })

  test('lets a segment carry its own ground, which is how tabs share a row', () => {
    const out = paint(
      [
        {
          background: '#000000',
          segments: [{ text: 'a' }, { text: 'b', background: '#ff0000' }, { text: 'c' }],
        },
      ],
      colour,
    )

    expect(out).toBe(`${ESC}[48;2;0;0;0ma${ESC}[48;2;255;0;0mb${ESC}[48;2;0;0;0mc${ESC}[49m`)
  })

  test('emits a colour once for a run of segments that share it', () => {
    const out = paint(
      [
        {
          segments: [
            { text: 'a', color: '#ffffff' },
            { text: 'b', color: '#ffffff' },
          ],
        },
      ],
      colour,
    )

    expect(out).toBe(`${ESC}[38;2;255;255;255mab${ESC}[39m`)
  })

  test('returns to the default colour between two coloured runs', () => {
    const out = paint([{ segments: [{ text: 'a', color: '#ff0000' }, { text: 'b' }] }], colour)

    expect(out).toBe(`${ESC}[38;2;255;0;0ma${ESC}[39mb`)
  })

  test('turns bold off again, so it does not leak into the next row', () => {
    const out = paint([{ segments: [{ text: 'a', bold: true }] }], colour)

    expect(out).toBe(`${ESC}[1ma${ESC}[22m`)
  })

  test('joins rows with a newline and nothing else', () => {
    const out = paint(
      [
        { background: '#000000', segments: [{ text: 'a' }] },
        { background: '#000000', segments: [{ text: 'b' }] },
      ],
      colour,
    )

    expect(out.split('\n')).toHaveLength(2)
  })

  test('a row that paints to its edge keeps the padding that gets it there', () => {
    // Ink trims every line, so padding with nothing after it is lost. The
    // closing codes are not whitespace, which is what saves it.
    const out = paint([{ background: '#000000', segments: [{ text: 'a    ' }] }], colour)

    expect(out.trimEnd()).toBe(out)
  })
})

/**
 * What the terminal can actually read.
 *
 * The whole hierarchy of this interface is carried by colour — whose pane this
 * is, which tab is live, what is running — and every one of those was written
 * as a 24-bit escape whatever the terminal said it could take. A terminal that
 * cannot read one shows the raw code or drops it, and either way the meaning
 * goes with it.
 */
describe('the colour a terminal can read', () => {
  test('says none when colour is refused, by either convention', () => {
    expect(depthOf({ NO_COLOR: '1' })).toBe('none')
    expect(depthOf({ FORCE_COLOR: '0' })).toBe('none')
  })

  test('believes a terminal that says it has truecolor', () => {
    expect(depthOf({ COLORTERM: 'truecolor' })).toBe('truecolor')
    expect(depthOf({ COLORTERM: '24bit' })).toBe('truecolor')
  })

  test('drops to 256 for a terminal that only claims that', () => {
    expect(depthOf({ TERM: 'xterm-256color' })).toBe('ansi256')
    expect(depthOf({ TERM: 'screen-256color' })).toBe('ansi256')
  })

  test('takes COLORTERM over TERM, because it is the more specific claim', () => {
    expect(depthOf({ TERM: 'xterm-256color', COLORTERM: 'truecolor' })).toBe('truecolor')
  })

  // Downgrading on silence would strip colour from every terminal that says
  // nothing, which is most of them and includes the ones that can take it.
  test('assumes truecolor when the terminal says nothing at all', () => {
    expect(depthOf({})).toBe('truecolor')
  })

  test('paints an indexed colour where truecolor cannot be read', () => {
    const out = paint([{ background: '#1e1e23', segments: [{ text: 'hi', color: '#a78bfa' }] }], {
      TERM: 'xterm-256color',
    })

    expect(out).not.toContain('48;2;')
    expect(out).not.toContain('38;2;')
    expect(out).toContain('48;5;')
    expect(out).toContain('38;5;')
  })

  test('picks the grey ramp for a colour with no colour in it', () => {
    // 232-255 is the 24-step grey ramp; the cube would round #808080 to a
    // muddier grey than the ramp has exactly.
    expect(indexOf('#808080')).toBeGreaterThanOrEqual(232)
    expect(indexOf('#000000')).toBe(16)
    expect(indexOf('#ffffff')).toBe(231)
  })

  test('keeps a saturated colour in the cube rather than flattening it to grey', () => {
    const violet = indexOf('#a78bfa')
    expect(violet).toBeGreaterThanOrEqual(16)
    expect(violet).toBeLessThan(232)
  })

  test('still writes nothing but text when colour is off', () => {
    const out = paint([{ background: '#1e1e23', segments: [{ text: 'hi', color: '#a78bfa' }] }], {
      NO_COLOR: '1',
      TERM: 'xterm-256color',
    })

    expect(out).toBe('hi')
  })
})
