import { describe, expect, test } from 'bun:test'
import { indexOf } from './components/paint.ts'
import { BUILT_IN, DEFAULT_THEME, loadThemes, themeNamed } from './theme.ts'

/** Relative luminance, the way the contrast standard defines it. */
function luminance(hex: string): number {
  const channel = (at: number): number => {
    const value = Number.parseInt(hex.slice(at, at + 2), 16) / 255
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  }
  return 0.2126 * channel(1) + 0.7152 * channel(3) + 0.0722 * channel(5)
}

/** How far apart two colours look, as a straight distance in RGB. */
function apart(a: string, b: string): number {
  const channels = (hex: string) =>
    [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16))
  const [x, y] = [channels(a), channels(b)]
  return Math.hypot((x[0] ?? 0) - (y[0] ?? 0), (x[1] ?? 0) - (y[1] ?? 0), (x[2] ?? 0) - (y[2] ?? 0))
}

/** How far apart two colours are, 1 (identical) to 21 (black on white). */
function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05)
}

describe('every theme that ships', () => {
  for (const theme of BUILT_IN) {
    describe(theme.name, () => {
      test('is a complete set of real colours', () => {
        // A theme missing one colour is unreadable in a way that is hard to
        // attribute, which is why a file that omits one inherits it — and a
        // built-in one has nothing to inherit from.
        for (const [role, value] of Object.entries(theme)) {
          // `fill` is a decision about whether grounds are painted, not a
          // colour, and it is checked on its own below.
          if (role === 'name' || role === 'voices' || role === 'fill') continue
          expect(value).toMatch(/^#[0-9a-f]{6}$/)
        }
        expect(theme.voices.length).toBeGreaterThanOrEqual(6)
        for (const voice of theme.voices) expect(voice).toMatch(/^#[0-9a-f]{6}$/)
      })

      test('can be read on its own ground', () => {
        // Ordinary text against the filled areas. Below about 4.5 the standard
        // calls it a failure, and a terminal read for hours is not the place
        // to be adventurous about it.
        expect(contrast(theme.text, theme.surface)).toBeGreaterThan(4.5)
      })

      test('keeps the quietest colour legible rather than invisible', () => {
        // `faint` is the quietest thing that is still meant to be read. A
        // theme where it disappears has a rule nobody can see and a trace that
        // looks empty.
        expect(contrast(theme.faint, theme.surface)).toBeGreaterThan(2)
      })

      test('says what is wrong in a colour you can see', () => {
        for (const role of ['ok', 'warn', 'bad', 'accent'] as const) {
          expect(contrast(theme[role], theme.surface)).toBeGreaterThan(3)
        }
      })

      test('gives every agent a voice that reads on a filled tab', () => {
        // A tab is the voice filled with `onVoice` written on it, so the pair
        // has to work in that direction too.
        for (const voice of theme.voices) {
          expect(contrast(theme.onVoice, voice)).toBeGreaterThan(4.5)
        }
      })

      test('gives no two agents the same voice twice over', () => {
        // Distance in colour rather than in brightness: two voices can be
        // equally bright and obviously different, which is what a hue is for,
        // and measuring only luminance failed the two themes that are one hue
        // on purpose. The bar is set where a genuine duplicate is caught and a
        // deliberately monochrome palette is not.
        const four = theme.voices.slice(0, 4)
        for (const [at, voice] of four.entries()) {
          for (const other of four.slice(at + 1)) {
            expect(apart(voice, other)).toBeGreaterThan(25)
          }
        }
      })
    })
  }

  test('every name is its own', () => {
    const names = BUILT_IN.map((theme) => theme.name)
    expect(new Set(names).size).toBe(names.length)
  })
})

/**
 * What the default has to survive, and the others do not.
 *
 * A theme somebody chose is a preference and they can see what they picked.
 * The default is the one nobody chose, so it has to work for whoever turns out
 * to be sitting there — including the roughly one man in twelve who cannot
 * separate red from green, and anybody on a terminal that cannot read a 24-bit
 * escape. `mono` is monochrome on purpose and would fail all of this, which is
 * exactly why these are asked of the default alone.
 */
describe('the theme nobody chose', () => {
  /** Deuteranopia and protanopia: the two that between them are most of it. */
  const deuteranope = (hex: string): string =>
    shift(hex, [0.625, 0.375, 0, 0.7, 0.3, 0, 0, 0.3, 0.7])
  const protanope = (hex: string): string =>
    shift(hex, [0.567, 0.433, 0, 0.558, 0.442, 0, 0, 0.242, 0.758])

  function shift(hex: string, m: number[]): string {
    const [r, g, b] = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16)) as [
      number,
      number,
      number,
    ]
    const to = (x: number, y: number, z: number) =>
      Math.round(Math.max(0, Math.min(255, (m[x] ?? 0) * r + (m[y] ?? 0) * g + (m[z] ?? 0) * b)))
        .toString(16)
        .padStart(2, '0')
    return `#${to(0, 1, 2)}${to(3, 4, 5)}${to(6, 7, 8)}`
  }

  test('gives six agents six voices somebody who cannot see colour can still tell apart', () => {
    // The bar is where two voices read as one. It is not the bar for reading
    // them as a palette: the agent's name is written beside its colour, and
    // the colour is the fast answer rather than the only one.
    for (const [at, voice] of DEFAULT_THEME.voices.entries()) {
      for (const other of DEFAULT_THEME.voices.slice(at + 1)) {
        expect(apart(deuteranope(voice), deuteranope(other))).toBeGreaterThan(40)
        expect(apart(protanope(voice), protanope(other))).toBeGreaterThan(40)
      }
    }
  })

  test('keeps six voices six on a terminal with only 256 colours', () => {
    // Downgraded, several of the palettes here collapse two voices onto one
    // index and two agents become one colour. The default may not.
    const indices = DEFAULT_THEME.voices.map(indexOf)
    expect(new Set(indices).size).toBe(DEFAULT_THEME.voices.length)
  })

  test('never paints an agent the colour of a verdict about it', () => {
    // Downgraded as well as at full depth: an agent whose voice lands on the
    // same index as `bad` is an agent that looks broken.
    const states = [DEFAULT_THEME.ok, DEFAULT_THEME.warn, DEFAULT_THEME.bad].map(indexOf)
    for (const voice of DEFAULT_THEME.voices) expect(states).not.toContain(indexOf(voice))
  })

  test('keeps the chrome out of the six, so nothing structural looks like an agent', () => {
    for (const voice of DEFAULT_THEME.voices) {
      expect(apart(DEFAULT_THEME.accent, voice)).toBeGreaterThan(60)
    }
  })

  test('reads on its own ground with room to spare, not merely enough', () => {
    for (const voice of DEFAULT_THEME.voices) {
      expect(contrast(voice, DEFAULT_THEME.surface)).toBeGreaterThan(4.5)
    }
  })
})

/**
 * Whether a theme fills areas or only marks them.
 *
 * The interface painted a filled rectangle for every tab, and beside it two
 * more for the model and for whether the agent was loose — fifteen saturated
 * blocks across the top of a five-agent team, before a word of the
 * conversation. More colour is not more filled area, and the two had been
 * treated as the same thing.
 *
 * So it is an axis of the theme rather than a rewrite: `solid` fills, and
 * `hairline` puts the same colours on the text and the marks and leaves the
 * ground alone. Every palette works either way.
 */
describe('how much of a theme is filled in', () => {
  test('every theme says which it is, rather than leaving it to be guessed', () => {
    for (const theme of BUILT_IN) {
      expect(['solid', 'hairline']).toContain(theme.fill)
    }
  })

  test('ships both, so the choice is a setting and not a fork', () => {
    const fills = new Set(BUILT_IN.map((theme) => theme.fill))
    expect(fills.has('solid')).toBe(true)
    expect(fills.has('hairline')).toBe(true)
  })

  test('the one nobody chose is the quieter of the two', () => {
    // Filled was the default and it was the complaint: gaudy, and hard to
    // read because everything was emphasised and so nothing was.
    expect(DEFAULT_THEME.fill).toBe('hairline')
  })

  test('a theme file that says nothing about it gets the default', () => {
    // The field is new. A theme somebody wrote last week must not stop
    // loading because it does not mention something that did not exist.
    const loaded = loadThemes('/nowhere-at-all')
    for (const theme of loaded) expect(theme.fill).toBeDefined()
  })
})

/**
 * Choosing a palette and choosing how much of it is painted.
 *
 * Two questions, not one. Shipping `crew` as the only unfilled palette made
 * the quiet option cost you the colours, and the eight filled ones cost you
 * the quiet — when what is filled has nothing to do with which hues are used.
 * So the fill a palette declares is what it suggests, and saying otherwise
 * overrides it for whichever palette is in use: nine palettes, either way,
 * from a switch rather than eighteen entries in a list.
 */
describe('a palette and a fill are two choices', () => {
  test('any palette can be asked for unfilled', () => {
    for (const theme of BUILT_IN) {
      expect(themeNamed(BUILT_IN, theme.name, 'hairline').fill).toBe('hairline')
    }
  })

  test('any palette can be asked for filled', () => {
    for (const theme of BUILT_IN) {
      expect(themeNamed(BUILT_IN, theme.name, 'solid').fill).toBe('solid')
    }
  })

  test('overriding the fill changes nothing else about the palette', () => {
    const asked = themeNamed(BUILT_IN, 'neon', 'hairline')
    const declared = BUILT_IN.find((one) => one.name === 'neon')

    expect(asked.voices).toEqual(declared?.voices ?? [])
    expect(asked.accent).toBe(declared?.accent ?? '')
    expect(asked.name).toBe('neon')
  })

  test('asking for nothing keeps what the palette itself suggests', () => {
    expect(themeNamed(BUILT_IN, 'neon').fill).toBe('solid')
    expect(themeNamed(BUILT_IN, 'crew').fill).toBe('hairline')
  })

  test('a fill that is neither is ignored rather than drawn', () => {
    expect(themeNamed(BUILT_IN, 'neon', 'sparkly' as never).fill).toBe('solid')
  })
})
