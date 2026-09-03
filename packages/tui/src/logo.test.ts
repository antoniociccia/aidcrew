import { describe, expect, test } from 'bun:test'
import { wordmark, wordmarkText } from './logo.ts'
import { GRAPHITE } from './theme.ts'

describe('the wordmark', () => {
  test('reads AI, a padded D, then CREW', () => {
    const text = wordmark(GRAPHITE)
      .map((segment) => segment.text)
      .join('')
    expect(text).toBe('A I  D  C R E W')
  })

  test('D sits on a filled block in AI’s colour; AI and CREW stay plain segments', () => {
    const segments = wordmark(GRAPHITE)
    const badge = segments.find((segment) => segment.text.includes('D'))

    expect(badge?.background).toBe(GRAPHITE.voices[0])
    expect(badge?.color).toBe(GRAPHITE.onVoice)
    expect(badge?.bold).toBe(true)

    for (const segment of segments) {
      if (segment === badge) continue
      expect(segment.background).toBeUndefined()
    }

    const a = segments.find((segment) => segment.text === 'A')
    expect(a?.color).toBe(GRAPHITE.voices[0])

    const c = segments.find((segment) => segment.text === 'C')
    expect(c?.color).toBe(GRAPHITE.text)
  })

  test('falls back to the accent colour when a theme has fewer than two voices', () => {
    const oneVoice = { ...GRAPHITE, voices: [] }
    const segments = wordmark(oneVoice)
    const badge = segments.find((segment) => segment.text.includes('D'))
    const a = segments.find((segment) => segment.text === 'A')

    expect(badge?.background).toBe(GRAPHITE.accent)
    expect(a?.color).toBe(GRAPHITE.accent)
  })

  test('wordmarkText matches the coloured version, without colour', () => {
    expect(wordmarkText()).toBe('A I  D  C R E W')
  })
})

describe('the mark itself', () => {
  test('is the same whether the theme fills or not', () => {
    // A wordmark is not a decision about the skin. It was made compact on an
    // unfilled theme to save a row's worth of columns, which turned the one
    // thing on screen that identifies the program into something that changed
    // with a setting — two logos for one tool.
    const solid = wordmark({ ...GRAPHITE, fill: 'solid' })
    const bare = wordmark({ ...GRAPHITE, fill: 'hairline' })

    expect(bare).toEqual(solid)
  })

  test('keeps its filled letter, which is the part people recognise', () => {
    const drawn = wordmark({ ...GRAPHITE, fill: 'hairline' })

    expect(drawn.some((segment) => segment.background !== undefined)).toBe(true)
  })
})
