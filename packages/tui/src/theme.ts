import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The look of the interface, and where a different one comes from.
 *
 * Colours are named for what they mean, never for what they are, so a theme is
 * a list of decisions rather than a list of hex codes someone has to guess the
 * purpose of. A theme file that omits a colour inherits it, which is what
 * makes "the built-in one but with a different accent" a three-line file.
 */

/**
 * Whether a theme fills areas or only marks them.
 *
 * `solid` paints the ground: a tab is a filled rectangle in its agent's
 * colour, and so are the prompt and the tray. `hairline` puts the same colours
 * on the text and the marks — the name, the bar down a message, the spinner —
 * and leaves the ground alone.
 *
 * An axis rather than two sets of palettes, because it is orthogonal to the
 * colours: every one of these works either way, and which you want is about
 * the room and the screen rather than about the hues.
 *
 * It exists because filled was the only option and filled was too much. Five
 * agents drew fifteen saturated rectangles across the top — a tab, a model
 * stamp and a loose stamp each — before one word of the conversation. More
 * colour is not more filled area; treating those as the same thing is what
 * produced a screen where everything was emphasised and so nothing was.
 */
export type Fill = 'solid' | 'hairline'

export type Theme = {
  name: string
  /** Whether this theme paints grounds or only marks. */
  fill: Fill
  /** Chrome: titles, the current selection, anything structural. */
  accent: string
  /** Ordinary text. */
  text: string
  /** Present but not the point: models, paths, counts. Still readable. */
  muted: string
  /** The quietest thing that is still legible — rules, empty traces. */
  faint: string
  /** Text on a filled agent colour. Dark, because the fills are bright. */
  onVoice: string
  /** Something finished and worked. */
  ok: string
  /** Something needs attention but nothing is broken. */
  warn: string
  /** Something failed. */
  bad: string
  /** Filled areas: title bar, prompt, the selected row. */
  surface: string
  /** One per agent, cycled. Each keeps its colour for the whole session. */
  voices: string[]
}

/**
 * Graphite.
 *
 * A neutral grey ground with a lilac accent. The grey is the point: it is the
 * only background that does not tint the colours sitting on it, which matters
 * when those colours are carrying information.
 */
export const GRAPHITE: Theme = {
  name: 'graphite',
  fill: 'solid',
  accent: '#a78bfa',
  text: '#ececea',
  muted: '#a9a9b2',
  faint: '#6b6b76',
  ok: '#4ade80',
  warn: '#fbbf24',
  bad: '#fb7185',
  surface: '#1e1e23',
  onVoice: '#101012',
  voices: ['#a78bfa', '#7dd3fc', '#f0abfc', '#4ade80', '#fbbf24', '#fb7185'],
}

/**
 * Crew, the one you get before you have chosen one.
 *
 * The others are palettes borrowed from editors, which is fine for a choice
 * and wrong for a default: a tool whose subject is a crew of agents, each
 * holding a colour for a whole session, should not be wearing somebody else's.
 *
 * Six voices, six families of hue — sky, teal, pink, yellow, coral, purple —
 * because six is what a team needs and six families is the fewest that stay
 * six under the vision most people who cannot see colour have. That rules out
 * a second blue, which is the pairing every attempt at this collapses into.
 *
 * The warm end is a voice here, though warm is also where `warn` and `bad`
 * live. That is allowed because state stopped being carried by colour alone:
 * every state has a mark in `MARK`, so coral is only ever an agent's name and
 * never a verdict about it.
 *
 * The accent is bone rather than a hue, so the chrome can never be mistaken
 * for one of the six. That is the same rule, from the other side.
 *
 * Every claim above is a test in theme.test.ts, including the one about
 * colour-blindness and the one about what survives a 256-colour terminal.
 */
export const CREW: Theme = {
  name: 'crew',
  fill: 'hairline',
  accent: '#e8dcc0',
  text: '#e6e4ee',
  muted: '#a3a0b4',
  faint: '#6b6880',
  ok: '#39d085',
  warn: '#f7b23b',
  bad: '#ee6353',
  surface: '#14151d',
  onVoice: '#0e0f15',
  voices: ['#56b4e9', '#23c4a0', '#e58fc2', '#eddf5c', '#f08a5d', '#b98ae0'],
}

/**
 * The theme in force before anybody chooses, and the one a partial theme file
 * inherits from. Named once so that changing it is one edit rather than four.
 */
export const DEFAULT_THEME: Theme = CREW

export const BUILT_IN: Theme[] = [
  CREW,
  GRAPHITE,
  {
    name: 'ember',
    fill: 'solid',
    accent: '#e0a458',
    text: '#f3ece2',
    muted: '#b3a595',
    faint: '#7a6e5c',
    ok: '#51cc86',
    warn: '#e0a458',
    bad: '#e06c5f',
    surface: '#241e16',
    onVoice: '#0a0906',
    voices: ['#e0a458', '#d98b6a', '#c9a227', '#8fae6b', '#c98428', '#b5651d'],
  },
  {
    name: 'mono',
    fill: 'solid',
    accent: '#ffffff',
    text: '#e4e4e7',
    muted: '#a5a5ad',
    faint: '#6e6e77',
    ok: '#e4e4e7',
    warn: '#e4e4e7',
    bad: '#ffffff',
    surface: '#222226',
    onVoice: '#0e0e10',
    voices: ['#ffffff', '#c4c4cc', '#9a9aa4', '#7c7c85', '#e4e4e7', '#b0b0b8'],
  },
  {
    // Hot pink on near-black with acid green and orange, which is the palette
    // a certain much-copied editor theme made everybody's default in 2012.
    // Named for what it looks like rather than for that theme: a palette is
    // colours and colours are nobody's, but a name is somebody's.
    name: 'neon',
    fill: 'solid',
    accent: '#f92672',
    text: '#f8f8f2',
    muted: '#a6a49a',
    faint: '#6b695f',
    ok: '#a6e22e',
    warn: '#fd971f',
    bad: '#f92672',
    surface: '#272822',
    onVoice: '#1b1c18',
    voices: ['#f92672', '#a6e22e', '#66d9ef', '#fd971f', '#ae81ff', '#e6db74'],
  },
  {
    // The muted blue-grey ground with a soft blue accent that most editors
    // ship as their dark default. The quietest of these: nothing in it shouts,
    // which is the point when you are reading rather than looking.
    name: 'slate',
    fill: 'solid',
    accent: '#61afef',
    text: '#abb2bf',
    muted: '#7f8794',
    faint: '#545b66',
    ok: '#98c379',
    warn: '#e5c07b',
    bad: '#e06c75',
    surface: '#282c34',
    onVoice: '#1c1f24',
    voices: ['#61afef', '#98c379', '#c678dd', '#e5c07b', '#56b6c2', '#e06c75'],
  },
  {
    // Warm pink and cyan on a soft charcoal, the palette people describe as
    // "pastel but not weak". The voices are deliberately far apart in hue:
    // this one is for a team of five, where telling them apart at a glance is
    // the whole job of a colour.
    name: 'sorbet',
    fill: 'solid',
    accent: '#ff75b5',
    text: '#e6e6e6',
    muted: '#9a9a9a',
    faint: '#676767',
    ok: '#19f9d8',
    warn: '#ffb86c',
    bad: '#ff2c6d',
    surface: '#2a2c2d',
    onVoice: '#131415',
    voices: ['#ff75b5', '#19f9d8', '#ffb86c', '#6fc1ff', '#b084eb', '#ff2c6d'],
  },
  {
    // Cold and blue-grey, the northern palette: low contrast on purpose, for
    // a bright room and a long afternoon. The one to reach for when the others
    // are too loud rather than too quiet.
    name: 'frost',
    fill: 'solid',
    accent: '#88c0d0',
    text: '#eceff4',
    muted: '#9aa5b1',
    faint: '#68727e',
    ok: '#a3be8c',
    warn: '#ebcb8b',
    bad: '#bf616a',
    surface: '#2e3440',
    onVoice: '#101318',
    voices: ['#88c0d0', '#a3be8c', '#b48ead', '#ebcb8b', '#81a1c1', '#bf616a'],
  },
  {
    // Amber on brown: the one that reads as paper rather than as a screen,
    // and the only one here that is warm all the way through. Green and red
    // are earthy rather than bright so they sit on the ground instead of
    // floating over it.
    name: 'clay',
    fill: 'solid',
    accent: '#d79921',
    text: '#ebdbb2',
    muted: '#a89984',
    faint: '#7c6f64',
    ok: '#b8bb26',
    warn: '#fabd2f',
    bad: '#fb4934',
    surface: '#282828',
    onVoice: '#1d2021',
    voices: ['#d79921', '#b8bb26', '#83a598', '#fe8019', '#d3869b', '#fb4934'],
  },
]

/** Where a user's own themes live. One JSON file each; the name is the file. */
export const THEMES_DIR = join('.aidcrew', 'themes')

type PartialTheme = Partial<Omit<Theme, 'name'>> & { voices?: string[]; fill?: Fill }

/**
 * Reads the themes a user has written, falling back to the built-in ones.
 *
 * A theme that will not parse, or that names a colour that is not a colour, is
 * skipped rather than applied: half a theme is unreadable in a way that is
 * hard to attribute to a file nobody remembers writing.
 */
export function loadThemes(home: string): Theme[] {
  const directory = join(home, THEMES_DIR)

  let files: string[]
  try {
    files = readdirSync(directory)
      .filter((name) => name.endsWith('.json'))
      .sort()
  } catch {
    return BUILT_IN
  }

  const custom = files.flatMap((file): Theme[] => {
    try {
      const parsed = JSON.parse(readFileSync(join(directory, file), 'utf8')) as PartialTheme
      const name = file.replace(/\.json$/, '')
      // Merged onto the default, so a theme only has to say what it changes.
      return [{ ...DEFAULT_THEME, ...cleaned(parsed), name }]
    } catch {
      return []
    }
  })

  return [...custom, ...BUILT_IN]
}

const COLOUR = /^#[0-9a-fA-F]{6}$/

/** Keeps the fields that are actually colours, drops anything else. */
function cleaned(theme: PartialTheme): PartialTheme {
  const kept: PartialTheme = {}

  for (const [key, value] of Object.entries(theme)) {
    if (key === 'voices') {
      const voices = Array.isArray(value)
        ? value.filter((v) => typeof v === 'string' && COLOUR.test(v))
        : []
      if (voices.length > 0) kept.voices = voices
      continue
    }
    // The one field that is a decision rather than a colour. Kept only when
    // it is one of the two, so a typo inherits rather than drawing something
    // that is neither.
    if (key === 'fill') {
      if (value === 'solid' || value === 'hairline') kept.fill = value
      continue
    }
    if (typeof value === 'string' && COLOUR.test(value)) {
      ;(kept as Record<string, string>)[key] = value
    }
  }

  return kept
}

/**
 * The palette asked for, filled the way it was asked for.
 *
 * Two choices rather than one. Which hues you want and how much of the screen
 * is painted in them have nothing to do with each other, and shipping one
 * unfilled palette among eight filled ones made each answer cost the other:
 * the quiet option took the colours with it.
 *
 * The palette's own `fill` is what it suggests. `asked` overrides it for
 * whichever palette is in use, so nine palettes are available either way from
 * a switch rather than eighteen entries in a list. Anything that is not one
 * of the two is ignored, because a setting file is an input like any other.
 */
export function themeNamed(themes: Theme[], name: string | undefined, asked?: Fill): Theme {
  const found = themes.find((theme) => theme.name === name) ?? DEFAULT_THEME
  if (asked !== 'solid' && asked !== 'hairline') return found
  return { ...found, fill: asked }
}

/** An example file, so "write your own" is a copy rather than a guess. */
export const EXAMPLE_THEME = `{
  "accent": "#a78bfa",
  "text": "#ececea",
  "muted": "#8b8b93",
  "faint": "#3a3a40",
  "ok": "#4ade80",
  "warn": "#fbbf24",
  "bad": "#fb7185",
  "surface": "#17171a",
  "voices": ["#a78bfa", "#7dd3fc", "#f0abfc", "#4ade80"]
}
`

/** Status marks, kept in one place so every screen spells them the same. */
export const MARK = {
  working: '◆',
  idle: '·',
  stopped: '○',
  selected: '▸',
  /** Acting without being asked. A mark, because it is true of an agent
   *  rather than something it is doing, and marks are what the tab has room
   *  for once nothing on it is a filled block. */
  loose: '!',
} as const

/**
 * What each kind of line in a transcript is, said in its first column.
 *
 * The transcript already reserves two columns at its left edge and spent them
 * on nothing: only what you said and what the agent said were marked, and a
 * tool call, a thought, a session note and a failure all began with two
 * blanks and were told apart by their colour alone. That is one channel doing
 * four jobs, and it is the channel that goes first — piped to a file, on a
 * terminal that will not take the escape, or for a reader who cannot separate
 * amber from grey.
 *
 * Every glyph is one column wide under `widthOf`, which is asserted rather
 * than assumed: a two-column glyph here shifts every row after it.
 */
export const GUTTER: Record<'ask' | 'say' | 'tool' | 'error' | 'note' | 'thinking', string> = {
  /** What you asked for. */
  ask: '▶',
  /** What the agent said back, in the agent's own voice. */
  say: '▌',
  /** Something it did rather than said. */
  tool: '·',
  /** Reasoning, which is quieter than either. */
  thinking: '°',
  /** The session speaking about itself: compaction, cost, a workspace. */
  note: '▪',
  /** Something failed. */
  error: '!',
}

/** Braille turns one column wide at every frame, so nothing beside it shifts. */
export const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const
