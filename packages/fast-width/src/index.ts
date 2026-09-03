/**
 * How many terminal columns a string occupies.
 *
 * Published as a package because Ink needs it too: it calls `string-width` to
 * lay out every row of every frame, and the published one costs about 650µs
 * for any string containing a single non-ASCII character — it segments the
 * whole input and runs emoji regexes over it. A screen of Italian prose is
 * fifty such rows, so a frame took ninety milliseconds against under one for
 * the same screen in ASCII. Substituted through the workspace overrides, Ink
 * gets this instead without knowing.
 *
 * Counting characters is not counting columns: an emoji takes two cells, a CJK
 * character takes two, a combining mark takes none. Getting this wrong by one
 * pushes a padded row past the edge, the terminal wraps it, and every row
 * below shifts up.
 */

/** Ranges that take two cells: CJK, Hangul, fullwidth forms, emoji. */
const WIDE: [number, number][] = [
  [0x1100, 0x115f],
  [0x2e80, 0x303e],
  [0x3041, 0x33ff],
  [0x3400, 0x4dbf],
  [0x4e00, 0x9fff],
  [0xa000, 0xa4cf],
  [0xa960, 0xa97f],
  [0xac00, 0xd7a3],
  [0xf900, 0xfaff],
  [0xfe10, 0xfe19],
  [0xfe30, 0xfe6f],
  [0xff00, 0xff60],
  [0xffe0, 0xffe6],
  [0x16fe0, 0x16fe4],
  [0x17000, 0x18aff],
  [0x1b000, 0x1b12f],
  [0x1f004, 0x1f004],
  [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e],
  [0x1f191, 0x1f19a],
  [0x1f200, 0x1f320],
  [0x1f32d, 0x1f335],
  [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393],
  [0x1f3a0, 0x1f3ca],
  [0x1f3cf, 0x1f3d3],
  [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4],
  [0x1f3f8, 0x1f43e],
  [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc],
  [0x1f4ff, 0x1f53d],
  [0x1f54b, 0x1f54e],
  [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a],
  [0x1f595, 0x1f596],
  [0x1f5a4, 0x1f5a4],
  [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5],
  [0x1f6cc, 0x1f6cc],
  [0x1f6d0, 0x1f6d2],
  [0x1f6eb, 0x1f6ec],
  [0x1f6f4, 0x1f6fc],
  [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f93a],
  [0x1f93c, 0x1f945],
  [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1faff],
  [0x20000, 0x3fffd],
]

/**
 * Symbols that are drawn as emoji without being asked to, and so take two
 * cells. Their neighbours in the same block are narrow, which is why this is a
 * list and not a range.
 */
const EMOJI_BY_DEFAULT: [number, number][] = [
  [0x231a, 0x231b],
  [0x23e9, 0x23ec],
  [0x23f0, 0x23f0],
  [0x23f3, 0x23f3],
  [0x25fd, 0x25fe],
  [0x2614, 0x2615],
  [0x2648, 0x2653],
  [0x267f, 0x267f],
  [0x2693, 0x2693],
  [0x26a1, 0x26a1],
  [0x26aa, 0x26ab],
  [0x26bd, 0x26be],
  [0x26c4, 0x26c5],
  [0x26ce, 0x26ce],
  [0x26d4, 0x26d4],
  [0x26ea, 0x26ea],
  [0x26f2, 0x26f3],
  [0x26f5, 0x26f5],
  [0x26fa, 0x26fa],
  [0x26fd, 0x26fd],
  [0x2705, 0x2705],
  [0x270a, 0x270b],
  [0x2728, 0x2728],
  [0x274c, 0x274c],
  [0x274e, 0x274e],
  [0x2753, 0x2755],
  [0x2757, 0x2757],
  [0x2795, 0x2797],
  [0x27b0, 0x27b0],
  [0x27bf, 0x27bf],
  [0x2b1b, 0x2b1c],
  [0x2b50, 0x2b50],
  [0x2b55, 0x2b55],
]

/** Marks that attach to the character before them and take no cell of their own. */
const ZERO: [number, number][] = [
  [0x0300, 0x036f],
  [0x0483, 0x0489],
  [0x0591, 0x05bd],
  [0x0610, 0x061a],
  [0x064b, 0x065f],
  [0x0670, 0x0670],
  [0x06d6, 0x06dc],
  [0x0730, 0x074a],
  [0x07a6, 0x07b0],
  [0x0900, 0x0903],
  [0x093a, 0x094f],
  [0x0951, 0x0957],
  [0x1ab0, 0x1aff],
  [0x1dc0, 0x1dff],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x20d0, 0x20ff],
  [0xfe00, 0xfe0f],
  [0xfe20, 0xfe2f],
  [0xfeff, 0xfeff],
  [0xe0100, 0xe01ef],
]

function inRanges(code: number, ranges: [number, number][]): boolean {
  // Binary search: the tables are sorted, and this is called per code point.
  let low = 0
  let high = ranges.length - 1

  while (low <= high) {
    const middle = (low + high) >> 1
    const range = ranges[middle] as [number, number]
    if (code < range[0]) high = middle - 1
    else if (code > range[1]) low = middle + 1
    else return true
  }

  return false
}

/** Whether every character is one column, which is true of most text. */
const PLAIN = /^[\x20-\x7e]*$/

/**
 * Colour codes and the like, which take no columns at all.
 *
 * The package this replaces strips them before measuring, and anything that
 * measures already-styled text depends on that: Ink hands whole painted rows
 * to this function, and counting the escapes made every coloured row measure
 * several times its width — so Ink truncated the screen to one line.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: escape sequences begin with one
const ANSI = /[\u001b\u009b][[()#;?]*(?:\d{1,4}(?:;\d{0,4})*)?[0-9A-PR-TZcf-nqry=><]/g

export function widthOf(input: string): number {
  const text = input.includes('\u001b') ? input.replace(ANSI, '') : input
  if (PLAIN.test(text)) return text.length

  let total = 0
  let previous = 0

  for (const character of text) {
    const code = character.codePointAt(0) ?? 0

    // A variation selector asks the character before it to be drawn as emoji,
    // which makes a narrow symbol wide after the fact.
    if (code === 0xfe0f) {
      if (previous !== 0 && !inRanges(previous, WIDE) && !inRanges(previous, EMOJI_BY_DEFAULT)) {
        total += 1
      }
      continue
    }

    // A zero-width joiner and what follows it belong to the character already
    // counted: a family emoji is one glyph, however many people are in it.
    if (code === 0x200d) {
      previous = 0x200d
      continue
    }
    if (previous === 0x200d) {
      previous = code
      continue
    }

    previous = code

    if (code < 0x20 || code === 0x7f) continue
    if (inRanges(code, ZERO)) continue
    total += inRanges(code, WIDE) || inRanges(code, EMOJI_BY_DEFAULT) ? 2 : 1
  }

  return total
}

/** The same function under the name the package it replaces exports. */
export default widthOf
