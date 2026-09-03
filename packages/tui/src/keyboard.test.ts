import { describe, expect, test } from 'bun:test'
import { putBackKeys } from './keyboard.ts'

const ESC = '\u001b'

describe('putting back the keys a terminal will not send', () => {
  test('option-ò becomes the character that key is printed with', () => {
    // Measured with `aidcrew keys` on an Italian layout: the @ never arrives,
    // and by the time Ink has finished with it, option-ò and a plain ò are
    // the same keystroke with no modifier between them. So it is fixed here,
    // on the bytes, before anything has a chance to lose the difference.
    expect(putBackKeys(`${ESC}ò`)).toBe('@')
    expect(putBackKeys(`${ESC}à`)).toBe('#')
  })

  test('leaves a plain accented letter exactly as it is', () => {
    // Somebody writing "però" is writing però.
    expect(putBackKeys('però')).toBe('però')
  })

  test('leaves every other escape sequence untouched', () => {
    // Arrows, page keys and the mouse all arrive as escape sequences, and
    // touching them is how a keyboard fix becomes a broken mouse.
    for (const sequence of [`${ESC}[A`, `${ESC}[<0;10;5M`, `${ESC}b`, ESC]) {
      expect(putBackKeys(sequence)).toBe(sequence)
    }
  })

  test('fixes one in the middle of a longer read', () => {
    // A paste, or a key pressed while something else was still arriving.
    expect(putBackKeys(`look at ${ESC}òsrc/auth.ts`)).toBe('look at @src/auth.ts')
  })

  test('fixes two in the same read', () => {
    expect(putBackKeys(`${ESC}ò${ESC}à`)).toBe('@#')
  })

  test('passes anything without an escape in it straight through', () => {
    expect(putBackKeys('hello')).toBe('hello')
    expect(putBackKeys('')).toBe('')
  })
})
