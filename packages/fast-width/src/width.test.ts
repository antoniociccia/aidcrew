import { describe, expect, test } from 'bun:test'
import { widthOf } from './index.ts'

/**
 * The values here were read from the published `string-width` package, which
 * this replaces inside Ink. They are written out rather than compared against
 * it at run time because the substitution means that package is no longer
 * resolvable by name — which is the whole point of it.
 */

describe('the width of ordinary text', () => {
  test('counts ASCII by its length', () => {
    expect(widthOf('bun test')).toBe(8)
  })

  test('counts an accented letter once', () => {
    expect(widthOf('però')).toBe(4)
    expect(widthOf('você')).toBe(4)
  })

  test('counts the punctuation prose is full of', () => {
    // The fast path exists for exactly this: one em dash used to cost 650µs.
    expect(widthOf('a — b')).toBe(5)
    expect(widthOf('“quoted”')).toBe(8)
    expect(widthOf('and so on…')).toBe(10)
  })

  test('counts the characters an interface draws its rules with', () => {
    expect(widthOf('─'.repeat(40))).toBe(40)
    expect(widthOf('│ ▌ ▏ █')).toBe(7)
  })
})

describe('the width of everything harder', () => {
  test('counts an emoji as the two cells it takes', () => {
    expect(widthOf('✅')).toBe(2)
    expect(widthOf('ok ✅')).toBe(5)
  })

  test('counts a joined emoji once, not once per person in it', () => {
    expect(widthOf('👨‍👩‍👧‍👦')).toBe(2)
  })

  test('lets a variation selector widen the symbol before it', () => {
    expect(widthOf('✔')).toBe(1)
    expect(widthOf('✔️')).toBe(2)
  })

  test('counts full-width characters as two', () => {
    expect(widthOf('日本語')).toBe(6)
    expect(widthOf('ＡＢＣ')).toBe(6)
    expect(widthOf('한국어')).toBe(6)
  })

  test('gives a combining mark no width of its own', () => {
    expect(widthOf('é')).toBe(1)
  })

  test('ignores a zero-width space', () => {
    expect(widthOf('a​b')).toBe(2)
  })

  test('counts the braille a spinner is made of once', () => {
    expect(widthOf('⠋')).toBe(1)
  })
})

describe('text that has already been styled', () => {
  const ESC = '\u001b'

  test('does not count the colour codes', () => {
    // Ink hands whole painted rows to this function. Counting the escapes made
    // every coloured row measure several times its width, so Ink truncated the
    // screen to a single line — which is exactly how this was found.
    expect(widthOf(`${ESC}[38;2;167;139;250mcoder${ESC}[39m`)).toBe(5)
  })

  test('measures a fully painted row as its columns', () => {
    const row = `${ESC}[48;2;30;30;35m${' '.repeat(20)}${ESC}[49m`

    expect(widthOf(row)).toBe(20)
  })

  test('counts a newline as nothing, the way a control character is nothing', () => {
    expect(widthOf('uno\ndue')).toBe(6)
  })

  test('leaves text with no escapes in it alone', () => {
    expect(widthOf('no escapes here')).toBe(15)
  })
})
