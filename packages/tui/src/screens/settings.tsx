import type { KnownSecret } from '@aidcrew/cli'
import type { Key } from 'ink'
import { Box, Text, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import { forConfig, startAt } from '../browse.ts'
import { Select } from '../components/chrome.tsx'
import { Field, SecretInput } from '../components/input.tsx'
import type { PaintedRow } from '../components/paint.ts'
import { Picker } from '../components/picker.tsx'
import type { Segment } from '../components/row.ts'
import { measure } from '../components/row.ts'
import { blanks, Row, Surface } from '../components/surface.tsx'
import { wordmark } from '../logo.ts'
import type { Fill, Theme } from '../theme.ts'
import { useTheme } from '../theme-context.tsx'
import { headerTint } from '../tint.ts'
import { useMouse } from '../use-mouse.ts'

/**
 * Everything you can change, in one place, arranged so you can find it.
 *
 * A settings screen with one long list makes you read it top to bottom to
 * learn what exists. Tabs say what the categories are before you have read any
 * of them, and a tab you can click is a tab you can explore without knowing
 * the shortcut.
 *
 * What is shown of a key is only ever *that* it exists and its last few
 * characters. The key itself is never displayed, and never read back for
 * display.
 */

export type PluginSummary = {
  name: string
  version?: string | undefined
  tools: number
  providers: number
  loaders: number
  hooks: boolean
}

export type SourceKind = 'instructions' | 'skills' | 'agents' | 'orchestration'

export type SettingsProps = {
  /** Which scopes have a key, and where each one lives. */
  known: KnownSecret[]
  providers: string[]
  agents: string[]
  models: string[]
  defaults: { provider?: string; model?: string }
  /** Whether agents on a task keep a note the others can read. */
  sharedMemory: boolean
  /** Whether absolute paths are kept off the screen. */
  hidePaths: boolean
  /** Turns that on or off. Takes effect at once, like everything here. */
  onHidePaths(on: boolean): void
  /** Turns that on or off, in the project config where it belongs. */
  onSharedMemory(on: boolean): void
  /** Every palette, in both fills: what you pick is a look, not two settings. */
  themes: { name: string; fill: Fill }[]
  theme: string
  plugins: PluginSummary[]
  /** Where the sources of skills, agents and instructions are read from. */
  sources: { label: SourceKind; paths: string[] }[]
  /** The project, which is where a path picker opens and what paths are relative to. */
  cwd: string
  /** Where settings are kept, shown so nobody has to guess. */
  storePath: string
  onSaveKey(scope: string, apiKey: string): Promise<void>
  onForgetKey(scope: string): Promise<void>
  onSetDefault(what: 'provider' | 'model', value: string): void
  onSetTheme(name: string): void
  /** Whether the palette in use paints grounds or only marks them. */
  onSetFill(fill: Fill): void
  /** Where this project reads its instructions, skills and agents from. */
  onSetSources(kind: SourceKind, paths: string[]): void
  onWritePlugin(): void
  onClose(): void
  rows?: number
  columns?: number
}

const TABS = ['keys', 'defaults', 'look', 'plugins', 'sources'] as const
type Tab = (typeof TABS)[number]

/** What each tab is for, said once so the screen explains itself. */
const ABOUT: Record<Tab, string> = {
  keys: 'one per service, or one per agent when two agents are on different plans',
  defaults: 'used by any agent that does not name its own provider and model',
  look: 'every palette twice: filled, and marked only — the same colours either way',
  plugins: 'everything is one: tools, providers, loaders, hooks',
  sources: 'read where they already are, never copied and never converted',
}

type Mode =
  | { at: 'browse' }
  | { at: 'add'; kind: SourceKind }
  | { at: 'scope' }
  | { at: 'enter'; scope: string }
  | { at: 'saving' }
  | { at: 'pick'; what: 'provider' | 'model' }

export function Settings(props: SettingsProps) {
  const theme = useTheme()
  const window = useWindowSize()
  const rows = props.rows ?? window.rows
  const columns = props.columns ?? window.columns

  const [tab, setTab] = useState<Tab>('keys')
  const [mode, setMode] = useState<Mode>({ at: 'browse' })
  const [apiKey, setApiKey] = useState('')
  const [cursor, setCursor] = useState(0)

  const move = (step: number): void => {
    const next = TABS[(TABS.indexOf(tab) + step + TABS.length) % TABS.length]
    if (next) {
      setTab(next)
      setCursor(0)
    }
  }

  const tabs = tabStops(columns)

  useMouse((event) => {
    if (event.kind !== 'down' || mode.at !== 'browse') return
    // The tab strip is the second row: the title sits above it.
    if (event.row !== 1) return
    const hit = tabs.find(
      (stop) => event.column >= stop.from && event.column < stop.from + stop.width,
    )
    if (hit) {
      setTab(hit.tab)
      setCursor(0)
    }
  })

  async function save(scope: string): Promise<void> {
    if (apiKey.trim() === '') return
    setMode({ at: 'saving' })
    await props.onSaveKey(scope, apiKey.trim())
    setApiKey('')
    setMode({ at: 'browse' })
  }

  const rowsOfTab = listOf(tab, props, theme)

  const acts = actionsFor(props, cursor, setMode, theme.fill)

  /** Moving about: true when the key was one of these and is spent. */
  const navigate = (key: Key): boolean => {
    if (key.rightArrow || key.tab) move(1)
    else if (key.leftArrow) move(-1)
    else if (key.upArrow) setCursor((at) => Math.max(0, at - 1))
    else if (key.downArrow) setCursor((at) => Math.min(rowsOfTab.length - 1, at + 1))
    else return false
    return true
  }

  useInput((input, key) => {
    // Anything but browsing is a small form on top: escape backs out of it,
    // and nothing else here should reach the list underneath.
    if (mode.at !== 'browse') {
      if (key.escape) {
        setApiKey('')
        setMode({ at: 'browse' })
      }
      return
    }

    if (key.escape) return props.onClose()
    if (navigate(key)) return

    acts[tab](input, key.return === true)
  })

  const body: PaintedRow[] =
    mode.at === 'browse'
      ? rowsOfTab.map((line, at) => ({
          ...(at === cursor && line.selectable ? { background: theme.surface } : {}),
          segments: [{ text: at === cursor && line.selectable ? ' ❯ ' : '   ' }, ...line.segments],
        }))
      : []

  if (mode.at === 'add') {
    return (
      <Picker
        start={startAt(props.cwd)}
        title={`Where to read ${mode.kind} from`}
        rows={rows}
        columns={columns}
        onChoose={(path) => {
          props.onSetSources(mode.kind, [...pathsOf(props, mode.kind), forConfig(path, props.cwd)])
          setMode({ at: 'browse' })
        }}
        onCancel={() => setMode({ at: 'browse' })}
      />
    )
  }

  // The same frame the session has: tabs across the top, the work in the
  // middle, one rule, and the wordmark in the tray. A settings screen that
  // looks like a different program is a settings screen you leave quickly.
  const bodyRows = Math.max(1, rows - 4)

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Surface width={columns} rows={[strip(tabs, tab, theme)]} />
      <Row width={columns} left={[{ text: `  ${ABOUT[tab]}`, color: theme.faint }]} />

      {mode.at === 'browse' ? (
        <Box flexDirection="column" height={bodyRows}>
          {/* A blank row before the list: the description above it is prose
              and the list below is data, and running them together makes the
              first entry read as part of the sentence. */}
          <Surface
            width={columns}
            rows={[{ segments: [] }, ...body, ...blanks(Math.max(0, bodyRows - body.length - 1))]}
          />
        </Box>
      ) : (
        <Form
          mode={mode}
          props={props}
          apiKey={apiKey}
          onApiKey={setApiKey}
          onSave={save}
          onPicked={(what, value) => {
            props.onSetDefault(what, value)
            setMode({ at: 'browse' })
          }}
          onScope={(scope) => setMode({ at: 'enter', scope })}
        />
      )}

      <Row
        width={columns}
        left={[{ text: '─'.repeat(Math.max(0, columns)), color: theme.faint }]}
      />

      <Row
        width={columns}
        background={theme.surface}
        left={[
          { text: ' ' },
          ...wordmark(theme),
          { text: '   settings', color: theme.muted },
          { text: `  ${props.storePath}`, color: theme.faint },
        ]}
        right={hints(tab, mode.at, theme)}
      />
    </Box>
  )
}

type TabStop = { tab: Tab; from: number; width: number }

/** Where each tab sits, so a click can be turned back into a tab. */
function tabStops(columns: number): TabStop[] {
  const width = Math.max(10, Math.floor(columns / TABS.length))
  return TABS.map((tab, at) => ({ tab, from: at * width, width }))
}

function strip(stops: TabStop[], current: Tab, theme: Theme): PaintedRow {
  return {
    segments: stops.flatMap(({ tab, width }) => {
      const on = tab === current
      const label: Segment[] = [
        { text: '▏', color: on ? theme.accent : theme.faint },
        { text: ` ${tab}`, color: on ? theme.accent : theme.muted, bold: on },
      ]
      const gap = width - measure(label)
      const ground = on ? headerTint(theme.accent, theme.surface) : undefined

      return [
        ...label.map((segment) => ({ ...segment, ...(ground ? { background: ground } : {}) })),
        ...(gap > 0 ? [{ text: ' '.repeat(gap), ...(ground ? { background: ground } : {}) }] : []),
      ]
    }),
  }
}

type Line = { segments: Segment[]; selectable: boolean }

function listOf(tab: Tab, props: SettingsProps, theme: Theme): Line[] {
  const say = (text: string, color = theme.muted): Line => ({
    segments: [{ text, color }],
    selectable: false,
  })

  if (tab === 'keys') {
    if (props.known.length === 0) return [say('none yet — press a to add one')]
    return props.known.map((entry) => ({
      selectable: true,
      segments: [{ text: entry.scope }, { text: `   ${entry.hint}`, color: theme.faint }],
    }))
  }

  if (tab === 'defaults') {
    return [
      {
        selectable: false,
        segments: [
          { text: 'provider   ' },
          { text: props.defaults.provider ?? 'not set', color: theme.muted },
          { text: '    p to change', color: theme.faint },
        ],
      },
      {
        selectable: false,
        segments: [
          { text: 'model      ' },
          { text: props.defaults.model ?? 'not set', color: theme.muted },
          { text: '    m to change', color: theme.faint },
        ],
      },
      {
        selectable: false,
        segments: [
          { text: 'hide paths ' },
          {
            text: props.hidePaths ? 'on' : 'off',
            color: props.hidePaths ? theme.ok : theme.muted,
          },
          { text: '   h to change', color: theme.faint },
          {
            text: '   keeps /Users/you off the screen — for a recording or a shared call',
            color: theme.faint,
          },
        ],
      },
      {
        selectable: false,
        segments: [
          { text: 'team notes ' },
          {
            text: props.sharedMemory ? 'on' : 'off',
            color: props.sharedMemory ? theme.ok : theme.muted,
          },
          { text: '   n to change', color: theme.faint },
          {
            // What it costs, next to the switch: it is the kind of setting
            // that is cheap to turn on and shows up on a bill a week later.
            text: '   agents on a task share one short note — beta, costs a paragraph per request',
            color: theme.faint,
          },
        ],
      },
    ]
  }

  if (tab === 'look') {
    // Both fills of every palette, drawn as what they are: eighteen looks to
    // choose from. Offered as a palette list plus a switch, the second half of
    // the choice was invisible — you cannot pick from a list what the list
    // does not show.
    return props.themes.map((one) => ({
      selectable: true,
      segments: [
        { text: one.name.padEnd(10) },
        { text: one.fill === 'solid' ? 'filled' : 'marked only', color: theme.muted },
        ...(one.name === props.theme && one.fill === theme.fill
          ? [{ text: '   in use', color: theme.ok }]
          : []),
      ],
    }))
  }

  if (tab === 'plugins') {
    if (props.plugins.length === 0) return [say('none loaded')]
    return props.plugins.map((plugin) => ({
      selectable: true,
      segments: [
        { text: plugin.name },
        { text: `  ${plugin.version ?? ''}`, color: theme.faint },
        { text: `   ${supplies(plugin)}`, color: theme.muted },
      ],
    }))
  }

  return sourceRows(props).map((row) =>
    row.path === undefined
      ? { selectable: true, segments: [{ text: row.kind, color: theme.muted, bold: true }] }
      : { selectable: true, segments: [{ text: `    ${row.path}`, color: theme.faint }] },
  )
}

/**
 * The small form that appears on top of a tab.
 *
 * Adding a key, choosing a default: each is a question with one answer, and
 * each takes the whole area rather than opening inside a list, because a form
 * that shares the screen with what it is editing invites you to edit the wrong
 * one.
 */
function Form({
  mode,
  props,
  apiKey,
  onApiKey,
  onSave,
  onPicked,
  onScope,
}: {
  mode: Mode
  props: SettingsProps
  apiKey: string
  onApiKey(value: string): void
  onSave(scope: string): void
  onPicked(what: 'provider' | 'model', value: string): void
  onScope(scope: string): void
}) {
  const theme = useTheme()

  return (
    <Box flexDirection="column" flexGrow={1} paddingX={2} paddingY={1}>
      {mode.at === 'scope' ? (
        <>
          <Text color={theme.muted}>A key for what?</Text>
          <Select choices={scopesOf(props)} onChoose={onScope} />
        </>
      ) : null}

      {mode.at === 'pick' ? (
        <>
          <Text color={theme.muted}>Default {mode.what}</Text>
          <Select
            choices={(mode.what === 'provider' ? props.providers : props.models).map((id) => ({
              value: id,
              label: id,
            }))}
            onChoose={(value) => onPicked(mode.what, value)}
          />
        </>
      ) : null}

      {mode.at === 'enter' ? (
        <>
          <Text color={theme.muted}>Key for {mode.scope}</Text>
          <Box marginTop={1}>
            <Field label="key" focused>
              <SecretInput value={apiKey} onChange={onApiKey} onSubmit={() => onSave(mode.scope)} />
            </Field>
          </Box>
          <Box marginTop={1}>
            <Text color={theme.faint}>
              Kept in {props.storePath}, shown afterwards only as its last characters.
            </Text>
          </Box>
        </>
      ) : null}

      {mode.at === 'saving' ? <Text color={theme.muted}>saving…</Text> : null}
    </Box>
  )
}

/**
 * What each tab does with a key press of its own.
 *
 * Out of the component because it is a table of five independent behaviours,
 * and reading it inside a render made the tab you cared about the hardest one
 * to find.
 */
function actionsFor(
  props: SettingsProps,
  cursor: number,
  setMode: (mode: Mode) => void,
  /** What is painted now, so `f` can ask for the other one. */
  fill: Fill,
): Record<Tab, (input: string, entered: boolean) => void> {
  return {
    keys: (input) => {
      if (input === 'a') setMode({ at: 'scope' })
      if (input === 'd') {
        const target = props.known[cursor]
        if (target) void props.onForgetKey(target.scope)
      }
    },
    defaults: (input) => {
      if (input === 'p') setMode({ at: 'pick', what: 'provider' })
      if (input === 'm') setMode({ at: 'pick', what: 'model' })
      if (input === 'n') props.onSharedMemory(!props.sharedMemory)
      if (input === 'h') props.onHidePaths(!props.hidePaths)
    },
    look: (_input, entered) => {
      // One row is one look. Which hues and how much is painted are still two
      // settings underneath, because they are orthogonal — but choosing is one
      // act, and a list that showed only half of what it was choosing between
      // hid the half that had just been added.
      const chosen = props.themes[cursor]
      if (!entered || !chosen) return
      props.onSetTheme(chosen.name)
      props.onSetFill(chosen.fill)
    },
    plugins: (input) => {
      if (input === 'n') props.onWritePlugin()
    },
    sources: (input) => {
      const row = sourceRows(props)[cursor]
      if (!row) return
      if (input === 'a') setMode({ at: 'add', kind: row.kind })
      if (input === 'd' && row.path !== undefined) {
        const kept = pathsOf(props, row.kind).filter((path) => path !== row.path)
        props.onSetSources(row.kind, kept)
      }
    },
  }
}

type SourceRow = { kind: SourceKind; path?: string }

/**
 * The source paths as one flat list, so the cursor can sit on either a heading
 * or a path and both know which kind they belong to.
 */
function sourceRows(props: SettingsProps): SourceRow[] {
  return props.sources.flatMap(({ label, paths }) => [
    { kind: label },
    ...paths.map((path) => ({ kind: label, path })),
  ])
}

function pathsOf(props: SettingsProps, kind: SourceKind): string[] {
  return props.sources.find((source) => source.label === kind)?.paths ?? []
}

/** What a plugin brings, in a few words rather than four counters. */
function supplies(plugin: PluginSummary): string {
  const parts: string[] = []
  if (plugin.tools > 0) parts.push(`${plugin.tools} ${plugin.tools === 1 ? 'tool' : 'tools'}`)
  if (plugin.providers > 0)
    parts.push(`${plugin.providers} provider${plugin.providers === 1 ? '' : 's'}`)
  if (plugin.loaders > 0) parts.push(`${plugin.loaders} loader${plugin.loaders === 1 ? '' : 's'}`)
  if (plugin.hooks) parts.push('hooks')
  return parts.join(' · ')
}

function scopesOf(props: SettingsProps): { value: string; label: string; hint: string }[] {
  // A key can belong to a service or to one agent; the second is how two
  // agents on the same service run on different plans.
  return [
    ...props.providers.map((id) => ({
      value: `provider:${id}`,
      label: `provider:${id}`,
      hint: 'every agent on this service',
    })),
    ...props.agents.map((id) => ({
      value: `agent:${id}`,
      label: `agent:${id}`,
      hint: 'this agent alone, on its own plan',
    })),
  ]
}

function hints(tab: Tab, mode: Mode['at'], theme: Theme): Segment[] {
  const keys: [string, string][] =
    mode !== 'browse'
      ? [
          ['enter', 'choose'],
          ['esc', 'back'],
        ]
      : [
          ...(tab === 'keys'
            ? ([
                ['a', 'add'],
                ['d', 'forget'],
              ] as [string, string][])
            : []),
          ...(tab === 'defaults'
            ? ([
                ['p', 'provider'],
                ['m', 'model'],
              ] as [string, string][])
            : []),
          ...(tab === 'look' ? ([['enter', 'use']] as [string, string][]) : []),
          ...(tab === 'plugins' ? ([['n', 'have an agent write one']] as [string, string][]) : []),
          ...(tab === 'sources'
            ? ([
                ['a', 'add a directory'],
                ['d', 'remove'],
              ] as [string, string][])
            : []),
          ['←→', 'tab'],
          ['esc', 'back'],
        ]

  return keys.flatMap(([key, label]) => [
    { text: ` ${key}`, color: theme.muted, bold: true },
    { text: ` ${label} `, color: theme.faint },
  ])
}
