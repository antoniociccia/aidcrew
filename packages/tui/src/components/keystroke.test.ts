import { describe, expect, test } from 'bun:test'
import { keystroke } from './keystroke.ts'

const typing = (value: string, input: string, key = {}) => keystroke(value, input, key)

describe('typing a character', () => {
  test('adds it', () => {
    expect(typing('fi', 'x')).toEqual({ at: 'text', value: 'fix' })
  })

  test('adds one that needs the option key to type at all', () => {
    // `@` on an Italian keyboard, `#` on a British one: the terminal reports
    // the modifier along with the character, and refusing everything marked
    // meta made those characters impossible to type. Which is how a feature
    // for naming files with @ shipped without any way to type an @.
    expect(keystroke('look at ', '@', { meta: true })).toEqual({
      at: 'text',
      value: 'look at @',
    })
    expect(keystroke('', '#', { meta: true })).toEqual({ at: 'text', value: '#' })
  })

  test('adds a symbol a terminal reported as escape-then-character', () => {
    // What "option as meta" does to a key held with option. On several
    // layouts `@`, `#` and `~` need that key, so refusing everything after an
    // escape made those characters impossible to type at all.
    expect(keystroke('look at ', '@', { escape: true })).toEqual({
      at: 'text',
      value: 'look at @',
    })
    expect(keystroke('', '~', { escape: true })).toEqual({ at: 'text', value: '~' })
  })

  test('an escape and a symbol is the symbol', () => {
    // The keys a terminal will not send are put back on the way in, on the
    // bytes — see keyboard.ts, which has to do it there because Ink discards
    // the escape before this could see it. What reaches here is either a
    // shortcut or something somebody typed.
    expect(keystroke('', '~', { escape: true })).toEqual({ at: 'text', value: '~' })
  })

  test('a letter after escape is still a shortcut, not text', () => {
    // alt-b and alt-f move by word in every shell there is; typing a stray
    // `b` into a message instead would be worse than doing nothing.
    expect(keystroke('hello', 'b', { escape: true })).toEqual({ at: 'ignore' })
    expect(keystroke('hello', 'F', { escape: true })).toEqual({ at: 'ignore' })
  })

  test('escape on its own does nothing to the line', () => {
    expect(keystroke('hello', '', { escape: true })).toEqual({ at: 'ignore' })
  })

  test('adds an accented letter and an emoji', () => {
    expect(typing('perch', 'é')).toEqual({ at: 'text', value: 'perché' })
    expect(typing('', '🙂')).toEqual({ at: 'text', value: '🙂' })
  })

  test('takes a whole pasted line at once', () => {
    expect(typing('', 'src/auth/guard.ts')).toEqual({ at: 'text', value: 'src/auth/guard.ts' })
  })
})

describe('what must never become text', () => {
  test('a control chord belongs to whatever is listening for shortcuts', () => {
    expect(keystroke('hi', 'l', { ctrl: true })).toEqual({ at: 'ignore' })
  })

  test('arrows, tab and escape', () => {
    for (const key of [{ upArrow: true }, { tab: true }, { escape: true }]) {
      expect(keystroke('hi', '', key)).toEqual({ at: 'ignore' })
    }
  })

  test('a mouse report that arrived in the same read as a letter', () => {
    // The click is stripped and the letter survives: dropping the whole read
    // loses the keystroke, and keeping it types escape codes into a message.
    expect(typing('h', 'i[<0;10;5M')).toEqual({ at: 'text', value: 'hi' })
  })

  test('a key that sends nothing does not eat a word', () => {
    // The bug this catches: treating "no characters arrived" as a request to
    // delete a word made every arrow key delete a word. It was written that
    // way for control-w, which does not arrive empty at all.
    for (const key of [{ upArrow: true }, { leftArrow: true }, { tab: true }]) {
      expect(keystroke('fix the auth bug', '', key)).toEqual({ at: 'ignore' })
    }
  })

  test('control-w still deletes a word, which is what that was for', () => {
    expect(keystroke('fix the auth bug', 'w', { ctrl: true })).toEqual({
      at: 'text',
      value: 'fix the auth ',
    })
  })

  test('a bare control character', () => {
    expect(typing('hi', '')).toEqual({ at: 'ignore' })
  })
})

describe('deleting', () => {
  test('one character at a time', () => {
    expect(keystroke('fix', '', { backspace: true })).toEqual({ at: 'text', value: 'fi' })
  })

  test('a whole word with option or control held', () => {
    // Option-backspace on macOS, control-w everywhere. Neither did anything
    // at all, so correcting a long path meant holding backspace.
    expect(keystroke('fix the auth bug', '', { backspace: true, meta: true })).toEqual({
      at: 'text',
      value: 'fix the auth ',
    })
    expect(keystroke('fix the auth bug', '', { backspace: true, ctrl: true })).toEqual({
      at: 'text',
      value: 'fix the auth ',
    })
  })

  test('a word ending in a separator takes the separator with it', () => {
    // Correcting a path: after `src/auth/` you mean to get back to `src/`.
    expect(keystroke('read src/auth/', '', { backspace: true, meta: true })).toEqual({
      at: 'text',
      value: 'read src/',
    })
  })

  test('the last word of a line leaves nothing', () => {
    expect(keystroke('hello', '', { backspace: true, meta: true })).toEqual({
      at: 'text',
      value: '',
    })
  })

  test('deleting from an empty line stays empty', () => {
    expect(keystroke('', '', { backspace: true })).toEqual({ at: 'text', value: '' })
  })
})

describe('sending', () => {
  test('enter submits', () => {
    expect(keystroke('go', '', { return: true })).toEqual({ at: 'submit' })
  })
})

describe('the line-level shortcuts every terminal has', () => {
  const ctrl = (letter: string) => keystroke('a long line of text', letter, { ctrl: true } as never)

  test('control-u takes the whole line away', () => {
    // Properly it clears to the start of the line, and with no cursor here
    // that is the same thing. It is the fastest way out of a message you have
    // changed your mind about, and it did nothing at all.
    expect(ctrl('u')).toEqual({ at: 'text', value: '' })
  })

  test('control-w still takes only the last word', () => {
    // Which is the point of having both: one undoes a word, the other a
    // thought.
    expect(ctrl('w')).toEqual({ at: 'text', value: 'a long line of ' })
  })

  test('a control chord that means nothing here is left to the screen', () => {
    // The screen's own shortcuts live on control, and a field that swallowed
    // them would take ^e and ^s with it.
    expect(ctrl('e')).toEqual({ at: 'ignore' })
  })
})
