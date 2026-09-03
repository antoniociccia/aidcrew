import type { Segment } from './components/row.ts'
import type { Theme } from './theme.ts'

/**
 * The wordmark.
 *
 * AI, then D on a filled block in AI's own colour, then CREW. The block is
 * a background, not a border — the same technique a tab uses to carry its
 * agent's colour, so the wordmark is built the way the rest of the
 * interface already is, and `onVoice` is what keeps the letter readable on
 * top of a fill that bright. CREW stays the interface's plain text colour,
 * the quieter word next to the pair worth a second glance.
 *
 * It follows the theme for free: a theme that changes its voices changes
 * the wordmark, because they are the same list.
 */

const AI = 'AI'
const CREW = 'CREW'

function voicesOf(theme: Theme): [string, string] {
  const voices = theme.voices.length > 1 ? theme.voices : [theme.accent, theme.accent]
  return [voices[0] as string, voices[1] as string]
}

function spelled(word: string, color: string): Segment[] {
  return [...word].flatMap((letter, at) => [
    { text: letter, color, bold: true },
    ...(at < word.length - 1 ? [{ text: ' ' }] : []),
  ])
}

/**
 * The mark, the same everywhere.
 *
 * Not a decision about the skin. It was made compact on an unfilled theme to
 * win back a row's worth of columns, which turned the one thing on screen that
 * says which program this is into something that changed with a setting — two
 * logos for one tool, and neither of them the one people had learned.
 *
 * The filled letter stays for the same reason: it is the part that is
 * recognised, and a theme that paints nothing else can afford three cells.
 */
export function wordmark(theme: Theme): Segment[] {
  const [aiColor] = voicesOf(theme)

  return [
    ...spelled(AI, aiColor),
    { text: ' ' },
    { text: ' D ', background: aiColor, color: theme.onVoice, bold: true },
    { text: ' ' },
    ...spelled(CREW, theme.text),
  ]
}

/** The same word without colour, for anywhere a plain string is what fits. */
export function wordmarkText(): string {
  return `${[...AI].join(' ')}  D  ${[...CREW].join(' ')}`
}
