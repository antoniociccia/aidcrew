import { withoutMouse } from '../mouse.ts'

/**
 * What one keypress does to a line of text.
 *
 * Apart from the component so it can be tested without a terminal, and
 * because deciding what a key means turned out to be the whole difficulty:
 * the same stream carries typed characters, mouse reports, and escape
 * sequences that stand for a key held with a modifier, and telling them apart
 * wrong means either losing letters or typing control codes into a message.
 */

export type Keys = {
  return?: boolean
  backspace?: boolean
  delete?: boolean
  ctrl?: boolean
  meta?: boolean
  escape?: boolean
  tab?: boolean
  upArrow?: boolean
  downArrow?: boolean
  leftArrow?: boolean
  rightArrow?: boolean
}

export type Stroke =
  | { at: 'text'; value: string }
  | { at: 'submit' }
  /** Nothing this field should react to: a shortcut, an arrow, a mouse click. */
  | { at: 'ignore' }

/** Characters that end a word, for deleting one. */
const BOUNDARY = /[\s/\\.,;:@[\]{}()'"`-]/

export function keystroke(value: string, input: string, key: Keys): Stroke {
  if (key.return) return { at: 'submit' }

  // Option-backspace on macOS, and control-w everywhere: delete the word
  // behind the cursor. Neither used to do anything at all, so correcting a
  // long path meant holding backspace and watching it go one letter at a time.
  const wholeWord = (key.backspace || key.delete) && (key.meta || key.ctrl)
  if (wholeWord || (key.ctrl && input === 'w')) {
    return { at: 'text', value: deleteWord(value) }
  }
  if (input === '') return { at: 'text', value: deleteWord(value) }

  // Control-u clears the line. Properly it clears to the start of it, and
  // with no cursor here that is the same thing — it is the way out of a
  // message you have changed your mind about, and it did nothing at all.
  if (key.ctrl && input === 'u') return { at: 'text', value: '' }

  if (key.backspace || key.delete) return { at: 'text', value: value.slice(0, -1) }

  // Arrows and tab are navigation, and a control chord belongs to whatever
  // screen is listening for shortcuts.
  if (key.ctrl || key.tab) return { at: 'ignore' }

  // An escape followed by something is how a terminal set to "option as meta"
  // reports a key held with option. Which of the two it means depends on what
  // followed: a letter is a shortcut — alt-b, alt-f — while a symbol is a
  // character somebody was trying to type, because on several layouts `@`,
  // `#` and `~` need that key and there is no other way to produce them.
  // An escape and then a character. The keys a terminal will not send are put
  // back on the way in — see keyboard.ts, which has to do it there because Ink
  // discards the escape before this can see it — so what reaches here is
  // either a shortcut or a symbol somebody typed.
  if (key.escape) {
    const after = printable(input)
    if (after === '') return { at: 'ignore' }

    // A symbol is something somebody was typing; a plain letter is a
    // shortcut, and alt-b and alt-f move by word in every shell there is.
    return /^[a-z]$/i.test(after) ? { at: 'ignore' } : { at: 'text', value: value + after }
  }
  if (key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return { at: 'ignore' }

  // Deliberately not `key.meta`. On a keyboard where a character needs the
  // option key — `@` on an Italian layout, `#` on a British one — the
  // terminal reports the modifier along with the character, and refusing
  // everything marked meta made those characters impossible to type. What
  // matters is whether anything printable arrived, not which keys were held.
  //
  // Mouse reporting shares this stream, and a click while typing arrives in
  // the same read as the letter, so it is stripped rather than dropped.
  const typed = printable(input)
  if (typed === '') return { at: 'ignore' }

  return { at: 'text', value: value + typed }
}

/**
 * What of a read is text somebody typed.
 *
 * Mouse reporting shares this stream, and a click while typing arrives in the
 * same read as the letter — so it is stripped rather than the whole read
 * being dropped, which would lose the keystroke.
 */
function printable(input: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: removing them is the point
  return withoutMouse(input).replace(/[\u0000-\u001f\u007f]/g, '')
}

/**
 * Everything up to the start of the last word.
 *
 * Trailing separators go with the word they follow, so deleting after
 * `src/auth/` leaves `src/`, which is what somebody correcting a path means.
 */
function deleteWord(value: string): string {
  const trimmed = value.replace(/[\s/\\.,;:@[\]{}()'"`-]+$/, '')
  if (trimmed === '') return ''

  for (let at = trimmed.length - 1; at >= 0; at -= 1) {
    if (BOUNDARY.test(trimmed[at] as string)) return trimmed.slice(0, at + 1)
  }
  return ''
}
