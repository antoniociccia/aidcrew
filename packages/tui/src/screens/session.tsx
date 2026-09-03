import { copyToClipboard, osc52 } from '@aidcrew/cli'
import type { AgentSnapshot } from '@aidcrew/core'
import { tokensOf } from '@aidcrew/core'
import { money } from '@aidcrew/prices'
import { Box, Text, useInput, useStdout, useWindowSize } from 'ink'
import { useEffect, useMemo, useRef, useState } from 'react'
import { completions, fileCompletions, partialMention } from '../commands.ts'
import { FileFinder } from '../components/finder.tsx'
import { TextInput } from '../components/input.tsx'
import type { SessionNotice } from '../components/notice.tsx'
import { NoticeBox } from '../components/notice.tsx'
import type { PaintedRow } from '../components/paint.ts'
import { moveTo, tabAt } from '../components/reorder.ts'
import type { Segment } from '../components/row.ts'
import { clip, measure, split as splitAt } from '../components/row.ts'
import { blanks, Row, Surface } from '../components/surface.tsx'
import { fold, widthOf } from '../components/text-width.ts'
import type { DividerBox, PaneBox } from '../layout.ts'
import { dividerAt, paneAt, planPanes, resize } from '../layout.ts'
import { wordmark } from '../logo.ts'
import { hidePaths, shorten } from '../private.ts'
import { marquee, pulseOf } from '../pulse.ts'
import type { Theme } from '../theme.ts'
import { GUTTER, MARK, SPINNER } from '../theme.ts'
import { useTheme, useVoice } from '../theme-context.tsx'
import { headerTint, litTint, loudTint, mix, paneTint } from '../tint.ts'
import { pagesOf, toRows } from '../transcript.ts'
import type { UiState } from '../ui-state.ts'
import { useMouse } from '../use-mouse.ts'

/**
 * The screen you work from.
 *
 * One agent at a time gets the team as a row of tabs across the top, each in
 * its own colour, with the pane below tinted to match — whose work you are
 * reading is answered by the colour of the screen rather than by a label you
 * have to find. Side by side, the tabs go away: every agent already has its
 * name, its colour and its own prompt in front of you, and repeating the
 * roster above them spends five rows saying it twice.
 *
 * Everything below the header is painted a row at a time into a single string.
 * Asking Ink to lay out one element per row cost more per keystroke than
 * everything else the interface does put together.
 */

/** Rows of one pane's transcript, from where a drag began to where it is now. */
type Band = { pane: string; from: number; to: number }

/** Control chords the text field handles itself — see keystroke.ts. */
const EDITING_CHORDS = new Set(['w', 'u'])

export type Line = {
  agentId: string
  kind: 'ask' | 'say' | 'tool' | 'error' | 'note' | 'thinking'
  text: string
}

/**
 * What was typed at each agent, read back off the transcript.
 *
 * The history behind the up arrow, for a session that is a continuation of
 * one: the instructions are on the record already, and the arrow should reach
 * them.
 */
export function askedBefore(lines: readonly Line[]): Record<string, string[]> {
  const asked: Record<string, string[]> = {}
  for (const line of lines) {
    if (line.kind !== 'ask') continue
    const before = asked[line.agentId] ?? []
    asked[line.agentId] = [...before, line.text]
  }
  return asked
}

/**
 * One of the answers to a question, and the key that gives it.
 *
 * `tone` is what the answer costs, not what it does: green for the one that
 * changes nothing, amber for the one that spends, red for the one that throws
 * work away. Read at a glance, that is the part worth colouring.
 */
export type Answer = {
  key: string
  label: string
  tone: 'ok' | 'warn' | 'bad'
  take(): void
}

/**
 * Something an agent is waiting on a person for.
 *
 * Drawn in the pane of the agent it belongs to, never over the whole screen:
 * with a team, a question that takes the screen hides the other five agents
 * still working, and gives no clue which one is asking.
 *
 * The screen knows nothing about what is being asked — a tool call needing
 * approval and a busy recipient are the same shape here — so a third kind of
 * question costs nothing in this file.
 */
export type Pending = {
  /** Whose pane it is drawn in. */
  agentId: string
  /** What the agent is doing, as a phrase: "runs a command", "is busy". */
  because: string
  summary: string
  answers: Answer[]
  /**
   * The answer esc and enter give.
   *
   * Never the expensive one: this is what happens when somebody presses a key
   * without reading, which is most of the time.
   */
  safe: string
}

export type SessionProps = {
  workspace: string
  agents: AgentSnapshot[]
  lines: Line[]
  target: string
  onTarget(agentId: string): void
  onSend(text: string): void
  onOpenSettings(): void
  onOpenAgents(): void
  onSwitchWorkspace(): void
  onQuit(): void
  /**
   * The team in a new order, after a tab was dragged onto another.
   *
   * Given rather than done here: the order outlives the screen — it is what
   * you see next time you open the project — so whoever keeps the rest of
   * that keeps this too.
   */
  onReorder?(ids: string[]): void
  /**
   * Shows every key there is.
   *
   * `because` is set when an unbound control chord opened it, so the board can
   * say what it is answering rather than appearing for no stated reason.
   */
  onOpenKeys?(because?: string): void
  /** Drops what an agent has waiting, leaving the turn it is in alone. */
  onClearQueue?(agentId: string): void
  /** Opens the list of jobs this repository has open. */
  onOpenTasks?(): void
  rows?: number
  columns?: number
  /** Agents shown side by side; empty means only the one being addressed. */
  initialSplit?: string[]
  showThinking?: boolean
  /** A tool call waiting on a person, shown under the agent that asked. */
  pending?: Pending | undefined
  /** Half-typed text to start with. Only the preview and the tests use it. */
  initialDraft?: string
  /** Every file in the project, for completing a name typed with `@`. */
  files?: string[]
  /**
   * Whether to keep absolute paths off the screen.
   *
   * For a recording, a screenshot in an issue, a call somebody else is
   * watching: `/Users/ada/clients/…` is a client list, and a path is
   * genuinely useful the rest of the time.
   */
  hidePaths?: boolean
  /**
   * What plugins want to add, for one slot.
   *
   * Given as a function rather than as a list because it is asked per frame
   * and per agent: a plugin showing a branch name shows a different one in
   * each pane.
   */
  extras?(context: { slot: 'tray' | 'agent'; agent?: AgentSnapshot }): Segment[]
  /** Whether an agent's figure is a list price rather than a bill. */
  estimated?(agentId: string): boolean
  /** What each agent has spent, when anybody has said what its model costs. */
  costOf?(agentId: string): number | undefined
  /** What the session has spent, of the agents that can be priced. */
  totalCost?(): number | undefined
  /**
   * How many handoffs are outstanding: handed over and not answered.
   *
   * With three agents on one job, "is anybody blocked" is a question the
   * screen could not answer. A tab says working or idle, and an idle agent
   * somebody is waiting on looks exactly like one nobody needs.
   */
  waitingOn?(): number
  /**
   * What came off a plan rather than a card, at the provider's list price.
   *
   * Shown beside what was charged rather than added to it: one team on a
   * subscription and an API key at once is what this is for, and a single
   * figure answers neither "what did this cost me" nor "what would this have
   * cost".
   */
  onPlan?(): number | undefined
  /**
   * Something the session has to say that is nobody's news in particular.
   *
   * Drawn across the middle, over whatever is there, because filed under an
   * agent it would be a line in a pane you may not be looking at — and the
   * thing it usually has to say is that nothing is happening, which is a
   * complaint about silence that must not be hidden inside the silence.
   */
  notice?: SessionNotice | undefined
  /** Stops whatever the agent is doing now. */
  onCancel?(agentId: string): void
  /**
   * Puts text on the clipboard, for a drag over a pane.
   *
   * Injected so a test can watch what a selection would copy without putting
   * it on the machine's actual clipboard.
   */
  onCopy?(text: string): Promise<boolean>
  /** What is left of the plan, already written for the screen. */
  allowance?: string | undefined
  /** Unseen notices per agent, for the bell on each tab. */
  waiting?: Map<string, { count: number; weight: string }>
  /** How many are unseen anywhere, for the bell in the tray. */
  unseen?: number
  onOpenNotices?(): void
  /** How the interface was left last time, and where to save it again. */
  layout?: UiState | undefined
  /**
   * How the panes were left.
   *
   * Only what this screen knows: which job is open and who is running
   * unsupervised belong to the session around it, and are added there. A
   * screen that had to be told about tasks in order to save a pane width
   * would be a screen that knows too much.
   */
  onLayout?(state: Pick<UiState, 'split' | 'weights' | 'target' | 'reasoning'>): void
}

/** Name row, pulse row, and the rule that closes them. */
const HEADER_ROWS = 3

/** How often the running text in the header advances, in milliseconds. */
const PULSE_TICK = 120

export function Session(props: SessionProps) {
  const theme = useTheme()
  const voice = useVoice()
  const window = useWindowSize()
  const rows = props.rows ?? window.rows
  const columns = props.columns ?? window.columns

  // One draft per agent: a single shared field made it impossible to see who a
  // half-typed instruction was addressed to, which is the one thing a team
  // interface must never be vague about.
  // What has been sent, per agent, newest last. The up arrow walks back
  // through it the way every shell does: a message you got slightly wrong is
  // one you want back, not one you want to type again.
  // Seeded from the transcript, so the arrow works after a restart too. It
  // did not, and a person who wanted the same instruction sent again copied
  // the line off the screen, gutter mark and all — which is how `▶ ▶ make it
  // work` reached a model as an instruction.
  const [sent, setSent] = useState<Record<string, string[]>>(() => askedBefore(props.lines))
  // How far back the arrow has walked, per agent. Reset the moment anything
  // is typed, because walking back and then editing is a new message.
  const [recalled, setRecalled] = useState<Record<string, number>>({})

  const [drafts, setDrafts] = useState<Record<string, string>>(
    props.initialDraft === undefined ? {} : { [props.target]: props.initialDraft },
  )
  const [split, setSplit] = useState<string[]>(props.initialSplit ?? props.layout?.split ?? [])
  const [picking, setPicking] = useState(false)
  const [thinking, setThinking] = useState(props.showThinking ?? props.layout?.reasoning ?? false)
  // Relative, so a pane dragged wider keeps its share when the window changes.
  const [weights, setWeights] = useState<Record<string, number>>(props.layout?.weights ?? {})
  // How far back each agent's pane is scrolled, in pages. Per agent, because
  // reading one agent's history should not move anybody else's.
  const [pages, setPages] = useState<Record<string, number>>({})
  // One heartbeat for the whole screen, and only while something is running:
  // the header's running text and every working pane's spinner move together,
  // and nothing turns when nothing is happening.
  const frame = useTick(
    PULSE_TICK,
    props.agents.some((agent) => agent.status === 'working'),
  )

  // A slower beat of its own, and one that keeps going while everything is
  // idle: what an agent has spent is worth seeing when nothing is happening
  // too, which is exactly when the spinner's heartbeat has stopped.
  const showingSpend = useTick(SPEND_TICK, true) % 2 === 1
  const dragging = useRef<DividerBox | undefined>(undefined)

  // Saved whenever it changes rather than on the way out: a session that ends
  // with ^C or a closed window is the common case, not the exception.
  const onLayout = props.onLayout
  useEffect(() => {
    onLayout?.({ split, weights, target: props.target, reasoning: thinking })
  }, [onLayout, split, weights, props.target, thinking])

  const ids = props.agents.map((agent) => agent.id)
  const index = Math.max(0, ids.indexOf(props.target))
  const current = props.agents[index]

  // A table rather than a chain of conditions: these keys are also listed in
  // the tray, and two lists that have to agree should be one list.
  /** Empties one agent's line, leaving everybody else's alone. */
  const without =
    (id: string) =>
    (all: Record<string, string>): Record<string, string> => ({ ...all, [id]: '' })

  /**
   * Walks back through what has been sent to this agent, the way a shell does.
   *
   * A message you got slightly wrong is one you want back, not one you want to
   * type again — and with an agent on the other end, getting it slightly wrong
   * is the common case. Walking past the end puts the line back to empty
   * rather than sticking on the oldest, which is what makes it a way out as
   * well as a way back.
   */
  const recall = (by: number): void => {
    const id = props.target
    if (id === '') return
    const history = sent[id] ?? []
    if (history.length === 0) return

    const at = Math.min(history.length, Math.max(0, (recalled[id] ?? 0) + by))
    setRecalled((all) => ({ ...all, [id]: at }))
    setDrafts((all) => ({ ...all, [id]: at === 0 ? '' : (history[history.length - at] ?? '') }))
  }

  const turn = (by: number): void => {
    const agent = props.target
    if (agent === '') return
    setPages((current) => ({ ...current, [agent]: Math.max(0, (current[agent] ?? 0) + by) }))
  }

  const shortcuts: Record<string, () => void> = {
    l: () => (split.length > 0 ? setSplit([]) : setPicking(true)),
    b: () => turn(1),
    f: () => turn(-1),
    g: () => setPages((current) => ({ ...current, [props.target]: 0 })),
    x: () => props.onClearQueue?.(props.target),
    r: () => setThinking((shown) => !shown),
    p: () => setSelecting((on) => !on),
    // ^f is already a page forward, and paging is the thing you reach for
    // while reading. ^t is free, and this is a thing you reach for while
    // writing.
    t: () => setFinding(true),
    k: () => props.onOpenTasks?.(),
    e: props.onOpenAgents,
    n: () => props.onOpenNotices?.(),
    o: () => props.onOpenKeys?.(),
    s: props.onOpenSettings,
    // ^y rather than ^w: ^w deletes the word behind the cursor in every shell
    // and in the field here, and bound to both it deleted the word and threw
    // you out to the list of projects. ^p is the mouse.
    y: props.onSwitchWorkspace,
    // Empties the line if there is one, and quits if there is not — which is
    // what it does in every shell, and what somebody pressing it after
    // changing their mind about a long message means by it. Quitting with
    // half a message typed was losing the message and the session at once.
    c: () => {
      // Empties the line if there is one, quits if there is not — which is
      // what it does in every shell, and what somebody pressing it after
      // changing their mind about a long message means by it. Quitting with
      // half a message typed lost the message and the session at once.
      if ((drafts[props.target] ?? '') !== '') return setDrafts(without(props.target))
      props.onQuit()
    },
    u: () => setDrafts(without(props.target)),
  }

  useInput(
    (input, key) => {
      if (key.tab) return move(key.shift ? -1 : 1)
      if (key.leftArrow) return move(-1)
      if (key.rightArrow) return move(1)
      // Page keys work without a modifier: they are the one thing you reach
      // for while reading rather than while writing.
      if (key.pageUp) return turn(1)
      if (key.pageDown) return turn(-1)
      if (key.upArrow || key.downArrow) return recall(key.upArrow ? 1 : -1)
      // Stops what the agent is doing now and leaves it standing. A model
      // looping should cost you the turn, not the agent and its work.
      //
      // Not while a question is up in this pane: there, esc is the safe
      // answer, and taking it as a cancel as well stopped the agent before it
      // could react to being refused.
      if (key.escape) {
        if (props.pending?.agentId === props.target) return
        return props.onCancel?.(props.target)
      }
      if (key.ctrl) {
        // The field's own chords — delete a word, clear the line — are
        // nothing for the screen to report as unbound.
        if (EDITING_CHORDS.has(input)) return
        const bound = shortcuts[input]
        if (bound) return bound()
        // A control chord bound to nothing is somebody reaching for a key
        // they half-remember, which is exactly when the board is wanted. It
        // is the only form of "hold control to see what there is" a terminal
        // permits: it reports the chord, never the modifier on its own.
        return props.onOpenKeys?.(`^${input} does nothing`)
      }
    },
    // Not disabled while a question is waiting. It used to be, and the
    // question is only drawn in the pane of the agent that asked it — so an
    // agent asking while you looked at another one produced a screen with no
    // question on it and no working keys, which is a deadlock and read as the
    // interface having died.
    { isActive: !picking },
  )

  // Grouped once rather than filtered per agent per render: with four agents
  // that was four passes over the whole history every time anything changed,
  // and the cost grew with the conversation.
  const byAgent = useMemo(() => {
    const groups = new Map<string, Line[]>()
    for (const line of props.lines) {
      if (!thinking && line.kind === 'thinking') continue
      const group = groups.get(line.agentId)
      if (group) group.push(line)
      else groups.set(line.agentId, [line])
    }
    return groups
  }, [props.lines, thinking])

  const linesFor = (agentId: string): Line[] => byAgent.get(agentId) ?? []

  // Everything below runs before the early return for the split picker: a hook
  // that is skipped on some renders and not others changes the order React
  // sees, and the first ^L tore the interface apart.
  const shown = split.length > 0 ? props.agents.filter((a) => split.includes(a.id)) : []

  // Tab walks what is on screen. Side by side it used to walk the whole team,
  // so moving between two open panes meant pressing it past the agents you had
  // deliberately left out.
  const reachable = shown.length > 0 ? shown.map((agent) => agent.id) : ids
  const move = (step: number): void => {
    const at = Math.max(0, reachable.indexOf(props.target))
    const next = reachable[(at + step + reachable.length) % Math.max(1, reachable.length)]
    if (next) props.onTarget(next)
  }
  const headerRows = shown.length > 0 ? 0 : HEADER_ROWS
  // One row for the tray, one for the rule above it.
  const bodyRows = Math.max(4, rows - headerRows - 2)
  const plan = planPanes(
    shown.map((agent) => agent.id),
    columns,
    bodyRows,
    weights,
  )

  /** The wheel pages whichever pane it is over, not whichever has the focus. */
  const scroll = (column: number, row: number, by: number): void => {
    const over = shown.length > 0 ? paneAt(plan.panes, column, row - headerRows) : props.target
    if (!over) return
    setPages((current) => ({ ...current, [over]: Math.max(0, (current[over] ?? 0) + by) }))
  }

  /** A drag stays with the border it began on, even if the pointer outruns it. */
  const drag = (column: number): void => {
    const held = dragging.current
    if (!held) return
    const before = plan.panes.find((pane) => pane.id === held.before)
    const after = plan.panes.find((pane) => pane.id === held.after)
    if (!before || !after) return
    setWeights((current) => resize(current, held.before, held.after, column, { before, after }))
  }

  /** The tab being dragged, if a press on one has not come up yet. */
  const carrying = useRef<string | undefined>(undefined)

  /**
   * Puts the tab being carried where the mouse now is.
   *
   * Live rather than on release, because a tab that snaps into place only
   * when you let go is one you have to guess about while you are moving it.
   */
  const carry = (column: number): void => {
    const held = carrying.current
    if (!held) return
    const to = tabAt(column, columns, props.agents.length)
    if (to === undefined) return
    const moved = moveTo(ids, held, to)
    if (moved !== ids) props.onReorder?.(moved)
  }

  const press = (column: number, row: number): void => {
    // Above the body: the tabs, one agent per cell, and the whole cell is the
    // tab. This used to ignore the first two of its rows — a leftover from
    // when they were the wordmark — so only the bottom row of a tab could be
    // clicked, and everywhere else in it did nothing.
    if (row < headerRows) {
      // The last row of the header is the rule below the tabs, not a tab.
      if (row >= headerRows - 1) return
      const at = tabAt(column, columns, props.agents.length)
      const agent = at === undefined ? undefined : props.agents[at]
      if (!agent) return
      props.onTarget(agent.id)
      // Held, in case this turns into a drag. A press on a tab is a focus
      // either way; what makes it a move is the mouse leaving the tab before
      // it comes up.
      carrying.current = agent.id
      return
    }

    const inBody = row - headerRows
    const border = dividerAt(plan.dividers, column, inBody)
    if (border) {
      dragging.current = border
      return
    }

    const pane = paneAt(plan.panes, column, inBody)
    if (pane) props.onTarget(pane)
  }

  // A terminal reporting the mouse hands every drag to the program, so text
  // cannot be selected and cannot be copied. There is no way to have both, so
  // this hands the mouse back for as long as you need it.
  const [selecting, setSelecting] = useState(false)
  // The terminal itself, for the clipboard sequence the fallback writes.
  const { stdout } = useStdout()

  /**
   * Which pane a screen row is in, and which of its transcript rows.
   *
   * Nothing for the tabs, the title of a pane, the rule under it or the row
   * you type in: those are the interface rather than what an agent said, and
   * dragging over them selects nothing.
   */
  const bandAt = (column: number, row: number): { pane: string; row: number } | undefined => {
    if (row < headerRows) return undefined
    const inBody = row - headerRows
    if (dividerAt(plan.dividers, column, inBody)) return undefined

    const pane = shown.length > 0 ? paneAt(plan.panes, column, inBody) : current?.id
    if (pane === undefined) return undefined

    const top = shown.length > 0 ? (plan.panes.find((one) => one.id === pane)?.y ?? 0) + 1 : 0
    const at = inBody - top
    const held = painted.current.get(pane)?.length ?? 0
    return at >= 0 && at < held ? { pane, row: at } : undefined
  }

  /**
   * Dragging over what an agent said, to copy it.
   *
   * The mouse belongs to the interface — a click picks an agent, a drag moves
   * a divider — so selecting text needed `^p` to hand it back to the terminal
   * first, and everybody found that out by trying to copy something and
   * getting nothing. A drag inside a pane now selects rows and copies them on
   * release, which is what dragging over text means everywhere else.
   */
  const [selection, setSelection] = useState<Band | undefined>(undefined)
  /** What each pane last painted, for turning a selection into text. */
  const painted = useRef(new Map<string, string[]>())
  const [copied, setCopied] = useState<string | undefined>(undefined)
  // Said and then gone. What was copied is news for a moment, and a tray that
  // still says it a minute later is a tray with a stale word in it.
  useEffect(() => {
    if (copied === undefined) return
    const timer = setTimeout(() => setCopied(undefined), 4_000)
    return () => clearTimeout(timer)
  }, [copied])

  const copySelection = (band: Band): void => {
    const rows = painted.current.get(band.pane) ?? []
    const [first, last] = [Math.min(band.from, band.to), Math.max(band.from, band.to)]
    // Blank rows at either end are the padding that keeps a pane the height of
    // the window, not something somebody meant to copy.
    const text = rows
      .slice(first, last + 1)
      .join('\n')
      .replace(/^\n+|\n+$/g, '')
    if (text === '') return

    void (async () => {
      const done = await (props.onCopy ?? copyToClipboard)(text)
      // Failing that, the terminal itself: over SSH the commands above put
      // the text on the wrong machine's clipboard, and this asks the emulator
      // in front of the person to do it.
      if (!done) stdout.write(osc52(text))
      const count = text.split('\n').length
      setCopied(`copied ${count} line${count === 1 ? '' : 's'}`)
    })()
  }
  // Naming a file without typing `@`, which some keyboards make hard and some
  // terminal settings make impossible.
  const [finding, setFinding] = useState(false)

  useMouse((event) => {
    // The picker owns the screen while it is up; a click behind it would move
    // the focus to something nobody can see.
    if (picking) return

    if (event.kind === 'wheel') scroll(event.column, event.row, event.direction === 'up' ? 1 : -1)
    if (event.kind === 'up') {
      dragging.current = undefined
      carrying.current = undefined
      // A press and a release on one row is a click, which picked the pane
      // already; only something that moved was a selection.
      const band = selection
      setSelection(undefined)
      if (band && band.from !== band.to) copySelection(band)
    }
    if (event.kind === 'drag') {
      if (carrying.current) return carry(event.column)
      if (dragging.current) return drag(event.column)
      const over = bandAt(event.column, event.row)
      if (over && selection && over.pane === selection.pane) {
        setSelection({ ...selection, to: over.row })
      }
    }
    if (event.kind === 'down') {
      press(event.column, event.row)
      const over = bandAt(event.column, event.row)
      setSelection(over ? { pane: over.pane, from: over.row, to: over.row } : undefined)
    }
  }, !selecting)

  if (picking) {
    return (
      <SplitPicker
        agents={props.agents}
        chosen={split.length > 0 ? split : [props.target]}
        rows={rows}
        columns={columns}
        linesFor={linesFor}
        onDone={(picked) => {
          setSplit(picked.length > 1 ? picked : [])
          setPicking(false)
        }}
        onCancel={() => setPicking(false)}
      />
    )
  }

  if (finding) {
    return (
      <FileFinder
        files={props.files ?? []}
        rows={rows}
        columns={columns}
        onChoose={(path) => {
          setFinding(false)
          setDrafts((all) => {
            const held = all[props.target] ?? ''
            // A space after it, because the next thing typed is a sentence
            // about the file rather than more of its name.
            const joined = held === '' || held.endsWith(' ') ? held : `${held} `
            // Quoted when the name has a space in it, which is how the other
            // end reads one — see mentions.ts. Unquoted, the mention stopped
            // at the space and the message went out unable to read `docs/my`.
            const mention = /\s/.test(path) ? `@"${path}"` : `@${path}`
            return { ...all, [props.target]: `${joined}${mention} ` }
          })
        }}
        onCancel={() => setFinding(false)}
      />
    )
  }

  const send = (agentId: string, text: string): void => {
    if (text.trim() === '') {
      // The stall notice says "↵ tell coder to carry on", so enter on an
      // empty line in that agent's field has to be exactly that.
      if (props.notice?.to === agentId) props.onSend('carry on')
      return
    }
    props.onSend(text.trim())
    setDrafts((all) => ({ ...all, [agentId]: '' }))
  }

  const paneFor = (
    agent: AgentSnapshot | undefined,
    width: number,
    titled: boolean,
    tall: number,
  ) => (
    <Pane
      agent={agent}
      colour={voice(agent ? Math.max(0, ids.indexOf(agent.id)) : 0)}
      lines={agent ? linesFor(agent.id) : []}
      files={props.files ?? []}
      hidden={props.hidePaths === true}
      focused={agent?.id === props.target}
      rows={tall}
      width={width}
      titled={titled}
      page={agent ? (pages[agent.id] ?? 0) : 0}
      frame={frame}
      draft={agent ? (drafts[agent.id] ?? '') : ''}
      onDraft={(text) => {
        if (!agent) return
        setDrafts((all) => ({ ...all, [agent.id]: text }))
        // Walking back and then editing is a new message, not the old one.
        setRecalled((all) => ({ ...all, [agent.id]: 0 }))
      }}
      onSend={(text) => {
        if (!agent) return
        setSent((all) => ({ ...all, [agent.id]: [...(all[agent.id] ?? []), text] }))
        setRecalled((all) => ({ ...all, [agent.id]: 0 }))
        send(agent.id, text)
      }}
      pending={props.pending?.agentId === agent?.id ? props.pending : undefined}
      selected={agent && selection?.pane === agent.id ? selection : undefined}
      onPainted={(rows) => {
        if (agent) painted.current.set(agent.id, rows)
      }}
    />
  )

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      {shown.length === 0 ? (
        <Header
          extras={props.extras ?? (() => [])}
          showingSpend={showingSpend}
          asking={props.pending?.agentId}
          waiting={props.waiting ?? new Map()}
          frame={frame}
          spentOn={(agentId) => {
            const cost = props.costOf?.(agentId)
            return cost === undefined ? undefined : money(cost, props.estimated?.(agentId))
          }}
          agents={props.agents}
          target={props.target}
          split={split}
          voice={voice}
          columns={columns}
          linesFor={linesFor}
        />
      ) : null}

      <Box flexGrow={1} height={bodyRows}>
        {shown.length > 0 ? (
          <Grid agents={shown} plan={plan} theme={theme} paneFor={paneFor} />
        ) : (
          paneFor(current, columns, false, bodyRows)
        )}
      </Box>

      {/* Neutral on purpose: everything above belongs to an agent, and a rule
          in one agent's colour would look like part of that agent's pane. */}
      <Row
        width={columns}
        {...(theme.fill === 'hairline'
          ? {}
          : { background: mix(theme.faint, theme.surface, 0.55) })}
        left={[
          theme.fill === 'hairline'
            ? { text: '─'.repeat(Math.max(0, columns)), color: theme.faint }
            : { text: ' '.repeat(Math.max(0, columns)) },
        ]}
      />

      {props.notice ? <NoticeBox notice={props.notice} theme={theme} width={columns} /> : null}

      <Tray
        {...(copied ? { said: copied } : {})}
        columns={columns}
        extras={props.extras?.({ slot: 'tray' }) ?? []}
        selecting={selecting}
        theme={theme}
        split={shown.length > 0}
        thinking={thinking}
        colour={voice(index)}
        paged={(pages[props.target] ?? 0) > 0}
        queued={(current?.queued ?? 0) > 0}
        busy={current?.status === 'working'}
        unseen={props.unseen ?? 0}
        allowance={props.allowance}
        waiting={props.waitingOn?.() ?? 0}
        cost={(() => {
          const total = props.totalCost?.()
          return total === undefined ? undefined : money(total)
        })()}
        plan={(() => {
          const drawn = props.onPlan?.()
          return drawn === undefined ? undefined : money(drawn)
        })()}
        workspace={props.workspace}
        working={props.agents.filter((agent) => agent.status === 'working').length}
        loose={props.agents.filter((agent) => agent.yolo).length}
        spent={props.agents.reduce((total, agent) => total + tokensOf(agent.usage), 0)}
      />
    </Box>
  )
}

/**
 * The one row at the foot of the screen.
 *
 * The hints sit on the right, out of the way of the prompts on the left. Side
 * by side, the way back is the first thing on it and the brightest: with the
 * roster gone from the top, nothing else on screen says the view is split.
 */
function Tray({
  columns,
  theme,
  split,
  thinking,
  colour,
  paged,
  queued,
  busy,
  selecting,
  unseen,
  allowance,
  workspace,
  working,
  loose,
  waiting,
  spent,
  cost,
  plan,
  extras,
  said,
}: {
  columns: number
  theme: Theme
  /** Something that just happened and is worth a moment, like a copy. */
  said?: string
  split: boolean
  thinking: boolean
  colour: string
  paged: boolean
  queued: boolean
  /** Whether the agent being addressed is working, which is when esc matters. */
  busy: boolean
  /** Whether the mouse has been handed back so text can be selected. */
  selecting: boolean
  /** How many notices are unseen anywhere. */
  unseen: number
  /** What is left of the plan, for a service that sells one. */
  allowance: string | undefined
  /** What the session has cost, when every part of it can be priced. */
  cost: string | undefined
  /** What came off a plan rather than a card, when anybody is on one. */
  plan: string | undefined
  workspace: string
  working: number
  /** Handoffs handed over and not answered. */
  waiting: number
  /** How many agents are acting without being asked. */
  loose: number
  spent: number
  /** What plugins add to this row. */
  extras: Segment[]
}) {
  /*
   * Ordered by what would be missed if it were cut.
   *
   * The row runs out of width every time something is added to it, and until
   * now that meant deciding by hand which entry to sacrifice. What actually
   * matters is that a key which only appears when it applies — stop, drop,
   * hand the mouse back — is the one somebody is looking for at that moment,
   * while the permanent ones can be learned once and found again in /help.
   */
  const keys: [string, string][] = [
    ...(busy ? ([['esc', 'stop']] as [string, string][]) : []),
    ...(queued ? ([['^x', 'drop what is waiting']] as [string, string][]) : []),
    ...(selecting ? ([['^p', 'mouse back on']] as [string, string][]) : []),
    ...(paged ? ([['^g', 'latest']] as [string, string][]) : []),
    ...(unseen > 0 ? ([['^n', `${unseen} unseen`]] as [string, string][]) : []),
    ['tab', 'agent'],
    ['pgup', 'back'],
    ['^l', split ? 'unsplit' : 'split'],
    ['^r', thinking ? 'hide reasoning' : 'reasoning'],
    ['^t', 'name a file'],
    ['^k', 'tasks'],
    ['^e', 'team'],
    ['^o', 'every key'],
    ['^s', 'settings'],
    ['^y', 'project'],
    ['^c', 'quit'],
  ]

  const left: Segment[] = [
    { text: ' ' },
    ...wordmark(theme),
    ...(working > 0 ? [{ text: `  ${MARK.working} ${working}`, color: theme.ok }] : []),
    // Said here as well as on the tab, because the tab you are not looking at
    // is the one running unsupervised. It reads as a count when there are
    // several, which is the number that should worry you.
    ...(loose > 0 ? [{ text: `  ${loose} unleashed`, color: theme.warn, bold: true }] : []),
    // Beside the count of who is working, because the two together are the
    // whole of "what is this team doing": one says how many are busy, the
    // other how many are owed an answer.
    ...(waiting > 0 ? [{ text: `  ${waiting} waiting`, color: theme.muted }] : []),
    // Plugins last on this row too, and before the keys on the right, which
    // are the one thing that must always be readable.
    ...extras,
    { text: `  ${tokens(spent)}`, color: theme.faint },
    // The only number here that is money. Beside the token count rather than
    // instead of it: tokens say how much was moved and this says what it cost,
    // and on a team where each agent is on a different service the second is
    // the question the first cannot answer. Absent when any part of the
    // session has no published price — a blank is a question somebody asks,
    // and $0.00 is a lie they believe.
    ...(cost ? [{ text: `  ${cost}`, color: theme.text, bold: true }] : []),
    // Beside it, never added to it. This is the row the project exists to
    // draw: what a card was charged, and what the same afternoon drew off
    // something already paid for.
    ...(plan ? [{ text: `  ${plan} on plan`, color: theme.ok }] : []),
    // What is left of the plan the work is going through. A price per token is
    // the wrong question for a subscription; how much of it is gone is the
    // right one, and it is the number that ruins an afternoon when nobody
    // looked.
    ...(allowance ? [{ text: `  ${allowance}`, color: theme.warn }] : []),
    // Last, and only for a moment: what just happened, when something did.
    // A drag over a pane copies without a word otherwise, and a copy nobody
    // saw is a copy people do twice.
    ...(said ? [{ text: `  ${said}`, color: theme.ok, bold: true }] : []),
  ]

  // The way back sits with the menu rather than under the wordmark: the right
  // of this row is where you already look to find out what a key does.
  const badge: Segment[] = split
    ? [
        ...(theme.fill === 'hairline'
          ? [{ text: ' ^l ', color: colour, bold: true }]
          : [{ text: ' ^l ', color: theme.onVoice, bold: true, background: colour }]),
        { text: ' side by side  ', color: colour },
      ]
    : []

  // One column of margin at each end, said once. The row reserved a space on
  // the left and the keys brought their own trailing one on the right, so the
  // two edges were padded by different code and only agreed by accident.
  const MARGIN = 1
  const room = columns - measure(left) - measure(badge) - MARGIN * 2

  return (
    <Row
      width={columns}
      {...(theme.fill === 'hairline' ? {} : { background: theme.surface })}
      left={left}
      right={[...badge, ...fit(keys, theme, room), { text: ' '.repeat(MARGIN) }]}
    />
  )
}

/**
 * As many hints as there is room for, dropping from the end.
 *
 * The list is ordered by how often a key is wanted, so what goes first when
 * the window narrows is what was needed least. Choosing a fixed set instead
 * would mean choosing for one terminal width and being wrong at every other.
 */
function fit(keys: [string, string][], theme: Theme, room: number): Segment[] {
  for (let count = keys.length; count > 0; count--) {
    const shown = keys.slice(0, count).flatMap(([key, label]) => [
      { text: ` ${key}`, color: theme.muted, bold: true },
      { text: ` ${label} `, color: theme.faint },
    ])
    if (measure(shown) <= room) return shown
  }

  return []
}

/**
 * The wordmark, then the team as tabs.
 *
 * Each agent owns a column: name on top, what it is doing under that, model
 * and spend below. A thin edge in the agent's own colour opens every cell,
 * which is what turns a row of names into a row of tabs.
 *
 * How much work an agent has done is how far a fill reaches along its bottom
 * row — kept quieter than the name above it, so the two never compete.
 */
function Header({
  agents,
  target,
  split,
  voice,
  columns,
  linesFor,
  spentOn,
  frame,
  showingSpend,
  asking,
  waiting,
  extras,
}: {
  agents: AgentSnapshot[]
  target: string
  split: string[]
  voice(index: number): string
  columns: number
  linesFor(agentId: string): Line[]
  /** What this agent has cost, already written for the screen. */
  spentOn(agentId: string): string | undefined
  frame: number
  /** Whether the tabs are showing what each agent spent instead of its model. */
  showingSpend: boolean
  /** The agent waiting on a decision, if one is. */
  asking: string | undefined
  /** Unseen notices per agent, for the bell on each tab. */
  waiting: Map<string, { count: number; weight: string }>
  /** What plugins add, asked per slot and per agent. */
  extras(context: { slot: 'tray' | 'agent'; agent?: AgentSnapshot }): Segment[]
}) {
  const theme = useTheme()

  const spent = agents.reduce((total, agent) => total + tokensOf(agent.usage), 0)

  // One column each, sharing the width evenly. Below about fourteen columns a
  // name is more ellipsis than name, so past that the tabs stop being useful.
  const cell = agents.length > 0 ? Math.floor(columns / agents.length) : columns
  const inUse = voice(
    Math.max(
      0,
      agents.findIndex((agent) => agent.id === target),
    ),
  )

  const cells = (
    make: (agent: AgentSnapshot, at: number, selected: boolean) => Cell,
  ): PaintedRow => ({
    segments: agents.flatMap((agent, at) => {
      // Whole columns do not divide evenly, and the remainder used to be left
      // bare beside the last tab, which made the row look like it had come
      // loose from the edge of the window.
      const last = at === agents.length - 1
      const width = last ? columns - cell * (agents.length - 1) : cell
      const { background, content, right, fill, fillBackground } = make(
        agent,
        at,
        agent.id === target,
      )
      // Anything pinned right takes its room first, so the cell's own content
      // is what loses characters when the tab is narrow — the name repeats
      // down a column, the number beside it does not.
      const tail = right ?? []
      const room = width - 1 - measure(tail)
      const inside = clip(content, room)
      const gap = room - measure(inside)
      const body: Segment[] = [...inside, ...(gap > 0 ? [{ text: ' '.repeat(gap) }] : []), ...tail]

      // The cell is one run of background, except where a fill reaches: the
      // segments are cut there and the two halves take their ground from
      // either side of it.
      const [filled, rest]: [Segment[], Segment[]] =
        fill === undefined || fill <= 0 ? [[], body] : splitAt(body, Math.min(fill, width - 1))
      // A segment that brought its own ground keeps it: that is how a stamp
      // inside a tab — a word set against the tab rather than written on it —
      // survives being laid onto the cell's own background.
      const on = (segment: Segment, ground: string | undefined): Segment =>
        ground && segment.background === undefined ? { ...segment, background: ground } : segment

      return [
        // A blank, not a tick: the tab already carries the agent's colour and,
        // when it is the one being addressed, its own ground. A mark as well
        // was a third thing saying the same, and it read as a stray dash.
        on({ text: ' ', color: voice(at) }, fillBackground ?? background),
        ...filled.map((segment) => on(segment, fillBackground)),
        ...rest.map((segment) => on(segment, background)),
      ]
    }),
  })

  return (
    <Box flexDirection="column">
      <Box>
        <Surface
          width={columns}
          rows={
            cell < 14
              ? [
                  compactTeam(agents, target, voice, theme),
                  { segments: [] },
                  rule(columns, theme, inUse),
                ]
              : [
                  cells((agent, at, selected) =>
                    nameCell(
                      agent,
                      selected,
                      split.includes(agent.id),
                      voice(at),
                      theme,
                      spentOn(agent.id),
                      asking === agent.id,
                      waiting.get(agent.id)?.count ?? 0,
                      showingSpend,
                      extras({ slot: 'agent', agent }),
                    ),
                  ),
                  cells((agent, at, selected) =>
                    pulseCell(agent, selected, voice(at), theme, frame, linesFor(agent.id), cell, {
                      share: shareOf(agent, spent),
                      spent: tokensOf(agent.usage),
                    }),
                  ),
                  rule(columns, theme, inUse),
                ]
          }
        />
      </Box>
    </Box>
  )
}

/**
 * The line that closes the tabs.
 *
 * In the colour of the tab in use, and the same weight as the one above the
 * field you type in: the two of them are the top and bottom edge of one
 * agent's area, and drawn alike they read as a pair rather than as two
 * unrelated divisions of the screen.
 */
function rule(columns: number, theme: Theme, colour: string): PaintedRow {
  // Drawn rather than painted where nothing else is filled. A band of colour
  // and a line of colour divide the screen equally well, and only one of them
  // reads as a block.
  if (theme.fill === 'hairline') {
    return {
      segments: [
        { text: '─'.repeat(Math.max(0, columns)), color: mix(colour, theme.surface, 0.5) },
      ],
    }
  }

  return {
    background: mix(colour, theme.surface, 0.5),
    segments: [{ text: ' '.repeat(Math.max(0, columns)) }],
  }
}

type Cell = {
  background: string | undefined
  content: Segment[]
  /** Pinned to the right of the cell rather than following the content. */
  right?: Segment[]
  /** Columns at the start of the cell painted in `fillBackground` instead. */
  fill?: number
  fillBackground?: string
}

/** The agent's name, filled with its own colour when it is the one in use. */
function nameCell(
  agent: AgentSnapshot,
  selected: boolean,
  inSplit: boolean,
  colour: string,
  theme: Theme,
  cost: string | undefined,
  /** Whether this agent is waiting on a decision from you. */
  asking: boolean,
  /** How much happened in its pane while you were looking elsewhere. */
  bell: number,
  /** Whether this is one of the moments the tab shows tokens, not the model. */
  showingSpend: boolean,
  /** What plugins want to add to this agent's tab. */
  extras: Segment[],
): Cell {
  const working = agent.status === 'working'
  const bare = theme.fill === 'hairline'
  // On a filled tab the writing sits on the agent's colour and has to be dark
  // to be read. On an unfilled one there is nothing under it, so the colour
  // goes on the writing instead — which is the whole difference between the
  // two.
  const ink = selected && !bare ? theme.onVoice : undefined

  // An agent acting without being asked gets its tab turned up: its own
  // colour, several shades louder. The small bolt this replaced was correct
  // and easy to miss, and the one thing you must not miss is which agent is
  // running unsupervised — you find out otherwise from what it did. Still its
  // own colour, because whose work this is has to stay readable: a warning
  // hue would make every loose agent look like the same agent.
  const loose = agent.yolo
  const paper = loose
    ? selected
      ? litTint(colour)
      : loudTint(colour, theme.surface)
    : selected
      ? colour
      : headerTint(colour, theme.surface)

  return {
    background: bare ? undefined : paper,
    content: [
      { text: ' ' },
      {
        // The name is where the colour lives when nothing is filled: it is
        // the one thing on the tab that answers "whose", so it is the one
        // thing that is always its agent's own colour. Dimmed rather than
        // greyed when the tab is not the one in use, so the answer survives
        // while the emphasis moves.
        text: agent.id,
        color: bare
          ? selected
            ? colour
            : mix(colour, theme.surface, 0.45)
          : loose
            ? theme.onVoice
            : (ink ?? (selected ? colour : theme.muted)),
        bold: true,
      },
      // What it runs on, beside its name rather than on a row of its own: the
      // two belong together, and a whole row for one short string is a row the
      // conversation could have had.
      // What it runs on, or what it has spent — except while it is loose, when
      // the tab has one thing to say and says it. Set against the ground the
      // tab is not, so the word reads as a stamp on the tab rather than as
      // more of the tab's own writing.
      ...(loose
        ? bare
          ? // A mark, not a stamp. Shouting it in capitals on a filled block
            // was three of the fifteen rectangles this theme exists to remove,
            // and it said the same word three times across one screen.
            [{ text: ` ${MARK.loose}`, color: theme.warn, bold: true }]
          : [
              { text: ' ' },
              { text: ' UNLEASHED ', color: colour, bold: true, background: theme.surface },
            ]
        : [
            {
              text: `  ${badge(agent, showingSpend)}`,
              color: ink ? mix(ink, colour, 0.35) : mix(theme.muted, theme.surface, 0.35),
            },
          ]),
      // It is waiting on you. Marked in the tab because you may have looked
      // away since it asked, and a question nobody can find is an agent that
      // never finishes.
      ...(asking ? [{ text: ' ?', color: ink ?? theme.warn, bold: true }] : []),
      // What happened in this pane while you were looking at another one.
      ...(bell > 0 ? [{ text: ` ●${bell}`, color: ink ?? theme.warn }] : []),
      // How far its copy of the repository has fallen behind yours. It grows
      // while the agent does nothing, so it has to be visible without asking:
      // one that looks idle and current is the one that answers confidently
      // about code you changed an hour ago.
      ...(agent.behind > 0
        ? [{ text: ` ↓${agent.behind}`, color: ink ?? theme.warn, bold: true }]
        : []),
      {
        text: working ? ` ${MARK.working}` : inSplit ? ' ▪' : '',
        color: loose ? theme.onVoice : (ink ?? theme.ok),
      },
      // Whatever plugins add, after everything the interface itself says: an
      // addition that pushed the agent's own name sideways would be one that
      // made the tab worse.
      ...extras,
    ],
    right: [
      // What it has cost so far. Absent when nobody has said what the model
      // costs — which is not the same as free, and must not read as free.
      {
        text: cost === undefined ? '' : `${cost} `,
        color: loose ? theme.onVoice : (ink ?? theme.muted),
      },
    ],
  }
}

/**
 * What the agent is doing, or the last thing it said.
 *
 * This row held a sparkline of recent activity, which for an agent that had
 * done nothing was a row of `▁` — a row of the screen spent saying nothing.
 * Its own words are both more useful and better looking.
 */
function pulseCell(
  agent: AgentSnapshot,
  selected: boolean,
  colour: string,
  theme: Theme,
  frame: number,
  lines: Line[],
  cell: number,
  /** How much of the session's tokens this agent has spent, and how many. */
  work: { share: number; spent: number },
): Cell {
  const working = agent.status === 'working'
  const pulse = pulseOf(agent, lines)
  const colours = { working: colour, said: theme.muted, quiet: theme.faint }

  return {
    // Painted even when it is not the one in use: left bare, this row broke
    // the column in half and the tab stopped looking like one tab. How far the
    // brighter tone reaches along it is this agent's share of the work — the
    // information a bar chart would carry, in a row drawn anyway.
    ...(theme.fill === 'hairline'
      ? {
          background: undefined,
          fill: 0,
        }
      : {
          background: mix(colour, theme.surface, selected ? 0.72 : 0.9),
          fill: Math.round(work.share * (cell - 1)),
          fillBackground: mix(colour, theme.surface, selected ? 0.6 : 0.8),
        }),
    content: [
      { text: ' ' },
      {
        text: working ? (SPINNER[frame % SPINNER.length] ?? '') : MARK.selected,
        color: working ? colour : theme.faint,
      },
      { text: ' ' },
      {
        // Long text travels along the row rather than being cut: the width is
        // the same either way, so nothing below it ever reflows.
        text: working ? marquee(pulse.text, Math.max(0, cell - 5), frame) : pulse.text,
        color: colours[pulse.kind],
      },
    ],
  }
}

/** An agent's share of everything the session has spent. */
function shareOf(agent: AgentSnapshot, total: number): number {
  if (total <= 0) return 0
  return tokensOf(agent.usage) / total
}

/** The same team when there is no width for columns: one line, names only. */
function compactTeam(
  agents: AgentSnapshot[],
  target: string,
  voice: (index: number) => string,
  theme: Theme,
): PaintedRow {
  return {
    segments: agents.flatMap((agent, position) => [
      { text: '  ', color: voice(position) },
      {
        text: agent.id,
        color: agent.id === target ? voice(position) : theme.faint,
        bold: agent.id === target,
      },
    ]),
  }
}

/**
 * A counter that advances on a timer, and only while something is happening.
 *
 * The running text in the header needs a heartbeat of its own, but a timer
 * that keeps ticking with every agent idle re-renders the screen eight times a
 * second for no reason, and competes with typing.
 */
/** How long the tab shows the model, then what it has spent, then back. */
const SPEND_TICK = 4000

function useTick(every: number, running: boolean): number {
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    if (!running) return
    const timer = setInterval(() => setFrame((current) => current + 1), every)
    return () => clearInterval(timer)
  }, [every, running])

  return frame
}

/**
 * Several agents at once, placed where the plan says.
 *
 * The geometry is worked out in one place and used both to draw and to decide
 * what a click landed on: two versions of that arithmetic drift apart the
 * first time one of them is adjusted, and then the mouse points at the wrong
 * agent, which is worse than having no mouse at all.
 */
function Grid({
  agents,
  plan,
  theme,
  paneFor,
}: {
  agents: AgentSnapshot[]
  plan: { panes: PaneBox[]; dividers: DividerBox[] }
  theme: Theme
  paneFor(agent: AgentSnapshot, width: number, titled: boolean, tall: number): React.ReactNode
}) {
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const bands = [...new Set(plan.panes.map((pane) => pane.y))].sort((a, b) => a - b)

  return (
    <Box flexDirection="column" flexGrow={1}>
      {bands.map((y) => (
        <Box key={y} height={plan.panes.find((pane) => pane.y === y)?.height ?? 0}>
          {plan.panes
            .filter((pane) => pane.y === y)
            .map((pane, at) => {
              const agent = byId.get(pane.id)
              if (!agent) return null
              return (
                <Box key={pane.id}>
                  {at > 0 ? <Rule rows={pane.height} colour={theme.faint} /> : null}
                  {paneFor(agent, pane.width, true, pane.height)}
                </Box>
              )
            })}
        </Box>
      ))}
    </Box>
  )
}

/**
 * The rule between two panes.
 *
 * Drawn rather than left to the change in tint: side by side, two agents are
 * two conversations, and the eye needs to be told where one stops.
 */
function Rule({ rows, colour }: { rows: number; colour: string }) {
  return (
    <Box width={1}>
      <Text color={colour}>{Array.from({ length: rows }, () => '│').join('\n')}</Text>
    </Box>
  )
}

/**
 * One agent's area: what it is, then what it has said, growing from the bottom.
 *
 * The brief at the top is there because an agent that has not started yet used
 * to leave the screen empty, which reads as broken rather than as ready.
 */
function Pane({
  agent,
  colour,
  lines,
  focused,
  rows,
  width,
  titled,
  page,
  frame,
  draft,
  files,
  hidden,
  onDraft,
  onSend,
  pending,
  selected,
  onPainted,
}: {
  agent: AgentSnapshot | undefined
  colour: string
  lines: Line[]
  focused: boolean
  rows: number
  width: number
  titled: boolean
  page: number
  /** Advances while anything is working, so the spinner turns. */
  frame: number
  draft: string
  files: string[]
  /** Whether absolute paths are kept off the screen. */
  hidden: boolean
  onDraft(text: string): void
  onSend(text: string): void
  pending: Pending | undefined
  /** Rows the mouse is over, as indices into this pane's transcript. */
  selected: { from: number; to: number } | undefined
  /**
   * What this pane just painted, so a selection can be copied.
   *
   * Reported rather than recomputed: the rows depend on the width, the page,
   * whether a question is up and whether a completion row is showing, and a
   * second copy of that arithmetic would drift from this one the first time
   * either changed.
   */
  onPainted(rows: string[]): void
}) {
  const theme = useTheme()
  // Every pane carries its agent's colour, the one in use more of it: with
  // several open at once, whose work you are reading should be answered by the
  // colour of the area rather than by finding a label.
  // Nothing under the conversation on a hairline theme. Whose pane this is
  // and whether it has the keyboard are said by the gutter and the title, in
  // one column each, rather than by tinting every row of what the agent said.
  const ground =
    theme.fill === 'hairline'
      ? undefined
      : focused
        ? paneTint(colour, theme.surface)
        : mix(colour, theme.surface, 0.94)

  // Above the empty branch below, because a hook has to run on every render
  // whichever branch a component takes.
  const painting = useRef<string[]>([])
  useEffect(() => {
    onPainted(painting.current)
  })

  if (!agent) {
    return (
      <Box flexDirection="column" width={width}>
        <Surface
          width={width}
          rows={[
            { segments: [{ text: '  no agents yet — press ^e to add one', color: theme.muted }] },
            ...blanks(rows - 1),
          ]}
        />
      </Box>
    )
  }

  // One row for the title, then either this agent's prompt or, while it is
  // waiting on a decision, the question it is waiting on.
  const titleRows = titled ? 1 : 0
  // One row for the prompt, and one for the rule that separates it from the
  // conversation: without it the field you type in read as the next line of
  // what the agent had been saying.
  // What a slash or an `@` could become, while it is still being typed. Only
  // ever one row: a list that grows pushes the conversation up as you type,
  // and text that moves while you look at it is worse than no help at all.
  const typing = pending ? undefined : partialMention(draft)
  const named = typing === undefined ? [] : fileCompletions(typing, files)
  const hint = pending || typing !== undefined ? [] : completions(draft)
  const showing = hint.length > 0 || named.length > 0
  // The field grows downwards as it is typed, so the conversation above it
  // gets whatever is left rather than the field overflowing the window.
  const typed = pending ? [] : draftRows(draft, agent.id, width)
  const footRows = (pending ? ASK_ROWS : typed.length) + 1 + (showing ? 1 : 0)
  const room = Math.max(1, rows - titleRows - footRows)
  // Counting the pages means folding the history, so it is only worth knowing
  // while somebody is actually reading back through it. At the end — which is
  // where you are nearly always — the number is not shown and not needed.
  const back = page > 0 ? pagesOf(lines, width, room) : 0
  const at = Math.min(page, back)
  const body = transcript({
    agent,
    lines,
    colour,
    theme,
    ground,
    width,
    room,
    at,
    back,
    titled,
    frame,
    hidden,
    selected,
  })

  // Reported after the render rather than during it: the parent keeps this in
  // a ref, and a parent that re-rendered on every frame of a spinner would
  // cost more than everything else the interface does.
  painting.current = body.map(textOf)

  return (
    <Box flexDirection="column" width={width}>
      <Surface
        width={width}
        rows={[
          ...(titled
            ? [
                {
                  // Side by side there are no tabs, so everything a tab says
                  // has to be said here instead — otherwise splitting the
                  // screen loses the model, the spending, how far behind the
                  // repository the agent is, and whether it is acting
                  // unsupervised. There is room: a pane is four times a tab.
                  background:
                    theme.fill === 'hairline'
                      ? undefined
                      : agent.yolo
                        ? loudTint(colour, theme.surface)
                        : headerTint(colour, theme.surface),
                  segments: [
                    { text: ' ' },
                    // Only when it is working. Idle is the absence of working,
                    // and a mark that means "nothing is happening" is a mark
                    // you have to read to learn nothing.
                    { text: agent.status === 'working' ? MARK.working : ' ', color: colour },
                    { text: ` ${agent.id}`, color: focused ? colour : theme.muted, bold: focused },
                    { text: `  ${describe(agent)}`, color: theme.faint },
                    ...(spend(agent) === ''
                      ? []
                      : [{ text: `  ${spend(agent)}`, color: theme.faint }]),
                    // How far its copy of the repository has fallen behind
                    // yours. It grows while the agent does nothing.
                    ...(agent.behind > 0
                      ? [{ text: `  ↓${agent.behind}`, color: theme.warn, bold: true }]
                      : []),
                    ...(agent.yolo
                      ? [
                          { text: '  ' },
                          // Capitals on a filled block is the interface
                          // shouting the same word once per pane. Unfilled, it
                          // is a word among words and lowercase is enough.
                          theme.fill === 'hairline'
                            ? { text: `${MARK.loose} unleashed`, color: theme.warn, bold: true }
                            : {
                                text: ' UNLEASHED ',
                                color: colour,
                                bold: true,
                                background: theme.surface,
                              },
                        ]
                      : []),
                    // Only when it matters: a page number on the newest page
                    // is noise, and its absence is what says you are at the end.
                    ...(at > 0 ? [{ text: `   ${at} back of ${back}`, color: theme.warn }] : []),
                  ],
                },
              ]
            : []),
          ...body,
        ]}
      />

      {/* The edge between what an agent said and where you answer it. Drawn
          where nothing else is filled, painted where everything is — the same
          division either way, and only one of the two reads as a block. */}
      <Surface width={width} rows={[rule(width, theme, colour)]} />

      {showing ? (
        <Surface
          width={width}
          rows={[
            {
              background: theme.fill === 'hairline' ? undefined : mix(colour, theme.surface, 0.88),
              segments: [
                { text: ' ' },
                ...named.flatMap((file, at) => [
                  { text: file, color: at === 0 ? colour : theme.muted, bold: at === 0 },
                  { text: '  ' },
                ]),
                ...hint.flatMap((command, at) => [
                  { text: `/${command.name}`, color: colour, bold: at === 0 },
                  // What the first one takes, so the shape of the command is
                  // visible before it is typed wrong.
                  ...(at === 0 && command.args !== ''
                    ? [{ text: ` ${command.args}`, color: theme.muted }]
                    : []),
                  { text: '  ' },
                ]),
              ],
            },
          ]}
        />
      ) : null}

      {pending ? (
        <Ask question={pending} colour={colour} width={width} active={focused} />
      ) : (
        <Prompt
          agentId={agent.id}
          colour={colour}
          width={width}
          rows={typed}
          focused={focused}
          draft={draft}
          onDraft={onDraft}
          onSend={onSend}
          page={at}
          pages={back}
        />
      )}
    </Box>
  )
}

/**
 * The inside of a pane: where you are, who the agent is, and what it has said.
 *
 * Built as rows rather than as elements because the pane is painted whole, and
 * kept out of the component so the arithmetic that decides how many rows there
 * are can be read in one place.
 */
function transcript({
  agent,
  lines,
  hidden,
  colour,
  theme,
  ground,
  width,
  room,
  at,
  back,
  titled,
  frame,
  selected,
}: {
  agent: AgentSnapshot
  lines: Line[]
  colour: string
  theme: Theme
  ground: string | undefined
  width: number
  room: number
  at: number
  back: number
  titled: boolean
  /** Advances while anything is working, so the spinner turns. */
  frame: number
  /** Whether absolute paths are kept off the screen. */
  hidden: boolean
  /** Rows the mouse is over, as indices into the returned array. */
  selected: { from: number; to: number } | undefined
}): PaintedRow[] {
  // Where you are is said on the row you type in, which is where you are
  // looking when you scroll back. Saying it here as well was saying it twice.
  const marker: PaintedRow[] = []

  // Said at the foot of the pane, where the next words will appear. In the
  // header it is one line for the whole team; here it is this agent, and it is
  // the difference between "it is thinking" and "it has stopped".
  const working: PaintedRow[] =
    agent.status === 'working' && at === 0
      ? [
          {
            background: ground,
            segments: [
              { text: `  ${SPINNER[frame % SPINNER.length] ?? ''} `, color: colour },
              { text: pulseOf(agent, lines).text, color: theme.faint },
            ],
          },
        ]
      : []

  // Paths taken out before the rows are measured, so hiding one cannot change
  // where a line wraps and make the pane jump as the setting is turned on.
  const shown = hidden ? lines.map((line) => ({ ...line, text: hidePaths(line.text) })) : lines
  const visible = toRows(shown, width, room - marker.length - working.length, at)
  const brief = shown.length === 0 ? briefOf(agent, theme, hidden) : []

  const painted = [
    ...marker,
    ...brief.map((segments) => ({ background: ground, segments: [{ text: '  ' }, ...segments] })),
    ...blanks(room - visible.length - brief.length - marker.length - working.length, ground),
    ...visible.map((line) => transcriptRow(line, colour, theme, ground, titled)),
    ...working,
  ]

  // What the mouse is over, marked as it is dragged. Without it a selection
  // is a guess about which rows are about to be copied, and the answer only
  // arrives once they are on the clipboard.
  if (selected === undefined) return painted
  const [first, last] = [Math.min(selected.from, selected.to), Math.max(selected.from, selected.to)]
  return painted.map((row, at) =>
    at < first || at > last ? row : { ...row, background: mix(colour, theme.surface, 0.55) },
  )
}

/** What a painted row says, with the colour and the marker taken off. */
export function textOf(row: PaintedRow): string {
  return row.segments
    .map((segment) => segment.text)
    .join('')
    .replace(/\s+$/, '')
}

/** One row of what an agent said or did. */
function transcriptRow(
  line: { kind: Line['kind']; text: string; first: boolean },
  colour: string,
  theme: Theme,
  ground: string | undefined,
  /** Whether this pane shares the screen, which is the only time whose words
   * these are needs saying. */
  shared: boolean,
): PaintedRow {
  // What you asked, in your own words. Without it the transcript was half a
  // conversation: every answer, and nothing any of them was answering.
  if (line.kind === 'ask') {
    return {
      background: ground,
      segments: [
        { text: line.first ? GUTTER.ask : ' ', color: theme.accent },
        { text: ` ${line.text}`, color: theme.text, bold: true },
      ],
    }
  }

  if (line.kind === 'say') {
    // With one agent on screen there is nobody to tell it apart from, so only
    // the first line is marked. Side by side the bar earns its place: two
    // conversations need a boundary.
    //
    // The same block on every line, dimmed after the first — a thinner one on
    // the continuations left gaps between the rows, and a column of gaps is a
    // dashed line, which is the one thing this interface does not draw.
    return {
      background: ground,
      segments: shared
        ? [
            { text: GUTTER.say, color: line.first ? colour : mix(colour, theme.surface, 0.62) },
            { text: ` ${line.text}`, color: theme.text },
          ]
        : [
            { text: line.first ? GUTTER.say : ' ', color: colour },
            { text: ` ${line.text}`, color: theme.text },
          ],
    }
  }

  const tint: Record<string, string> = {
    tool: theme.muted,
    error: theme.bad,
    note: theme.warn,
    thinking: theme.faint,
  }
  const colours = tint[line.kind] ?? theme.muted

  // The mark on the first row only. A wrapped tool call is one call, and a
  // column of repeated marks reads as a list of them.
  return {
    background: ground,
    segments: [
      { text: line.first ? (GUTTER[line.kind] ?? ' ') : ' ', color: colours },
      { text: ` ${line.text}`, color: colours },
    ],
  }
}

/**
 * Who an agent is, for a pane that has nothing in it yet.
 *
 * An empty pane used to be an empty screen, which reads as broken rather than
 * as ready. This says what the agent is and where it will work, which is what
 * you want to know before handing it something.
 */
function briefOf(agent: AgentSnapshot, theme: Theme, hide = false): Segment[][] {
  // Not the name: it is already on the tab above, and in the pane's own title
  // when there is one. Saying it a third time is the first thing you read.
  return [
    [{ text: agent.model, color: theme.muted }],
    [
      {
        text: hide
          ? shorten(agent.workspace)
          : agent.isolated
            ? agent.workspace
            : `${agent.workspace} · shared`,
        color: theme.faint,
      },
    ],
  ]
}

/** Rows the question takes: what it wants, and the answers. */
const ASK_ROWS = 2

/**
 * How many rows a half-typed message takes, and what is on each of them.
 *
 * The field was one row that truncated, so a long instruction — which is what
 * a good instruction looks like — scrolled sideways out of the window as it
 * was typed, and you could not read back what you had written before sending
 * it. It grows downwards instead, taking rows from the conversation above,
 * which is the right trade: what you are about to send matters more than the
 * fifth line back of what was said.
 *
 * Capped, and the cap keeps the END: the cursor is at the end, and a field
 * that scrolled away from the cursor is worse than one that truncates.
 */
const MAX_PROMPT_ROWS = 8

export function draftRows(draft: string, agentId: string, width: number): string[] {
  const room = promptWidth(width, agentId)
  const rows = draft === '' ? [''] : fold(draft, room)
  // A trailing newline is a row somebody is about to type on.
  if (draft.endsWith('\n')) rows.push('')
  return rows.length > MAX_PROMPT_ROWS ? rows.slice(-MAX_PROMPT_ROWS) : rows
}

/** The columns a draft has to itself, once the name and the padding are out. */
function promptWidth(width: number, agentId: string): number {
  // Two for the gutter or the fill, two after the name, one for the cursor.
  return Math.max(8, width - widthOf(`  ${agentId}  `) - 5)
}

/**
 * A tool call waiting on a person, asked where the agent lives.
 *
 * It replaces that agent's prompt rather than taking the screen: with a team
 * running, a full-page interruption hides the other agents' work and makes you
 * lose your place — and the question is about one of them, not about all of
 * them. Typing into that column is off while it stands, so `y` answers the
 * question instead of landing in a sentence.
 */
function Ask({
  question,
  colour,
  width,
  active,
}: {
  question: Pending
  colour: string
  width: number
  /** Whether this pane has the keyboard. Only then does a key answer. */
  active: boolean
}) {
  const theme = useTheme()

  // Only from its own pane. Side by side, the architect's question took the
  // keys typed into the coder's field: `y` approved it, `a` granted a whole
  // scope for the session, `n` refused — while the letters went into the
  // draft as well.
  useInput(
    (input, key) => {
      // Enter is deliberately not the first answer: the safe one is what
      // happens when somebody presses a key without reading.
      const chosen =
        key.escape || key.return
          ? question.answers.find((answer) => answer.key === question.safe)
          : question.answers.find((answer) => answer.key === input)
      chosen?.take()
    },
    { isActive: active },
  )

  return (
    <Surface
      width={width}
      rows={[
        {
          background: mix(theme.warn, theme.surface, 0.76),
          segments: [
            { text: ' ' },
            { text: question.agentId, color: colour, bold: true },
            { text: ` ${question.because}: `, color: theme.muted },
            { text: question.summary, color: theme.text },
          ],
        },
        {
          background: theme.surface,
          segments: [
            { text: ' ' },
            ...question.answers.flatMap((answer) => [
              { text: answer.key, color: theme[answer.tone], bold: true },
              { text: ` ${answer.label}  `, color: theme.muted },
            ]),
          ],
        },
      ]}
    />
  )
}

/**
 * The field at the foot of one agent's column.
 *
 * Every column has its own, carrying the agent's name and colour, because a
 * single field at the bottom of the screen never says who a half-typed
 * instruction is about to go to — and with a team, sending work to the wrong
 * agent is the expensive mistake.
 *
 * The one you can type into is filled with the agent's own colour and the
 * others are barely there. Drawn evenly, the field you are in was one shade
 * away from the field you are not, and finding where to type took a moment
 * every time.
 */
function Prompt({
  agentId,
  colour,
  width,
  rows,
  focused,
  draft,
  onDraft,
  onSend,
  page,
  pages,
}: {
  agentId: string
  colour: string
  width: number
  /** The draft as it folds, one string per row. Always at least one. */
  rows: string[]
  focused: boolean
  draft: string
  onDraft(text: string): void
  onSend(text: string): void
  page: number
  pages: number
}) {
  const theme = useTheme()
  // Nothing where you type. An empty field with a cursor in it is already an
  // invitation, and a sentence telling you to write reappears every time you
  // finish a line — so the thing it says is only ever read once and occupies
  // the row for the rest of the session.
  const placeholder = ''
  const idle = focused ? placeholder : draft || 'tab to write here'

  // The cursor is a character too; leaving it out overflowed the row and Ink
  // answered by truncating the padding into an ellipsis.
  // The last row is where the cursor is, and the only one whose width has to
  // leave room for it.
  const last = rows[rows.length - 1] ?? ''
  const shown = focused ? widthOf(last) + 1 : widthOf(idle)
  const label = `  ${agentId}  `
  // Where you are in the history, pinned to the right of the row you type in:
  // the bottom of the pane is where you are looking when you scroll back, and
  // a marker at the top of it is a marker you have to go and find.
  const where = page > 0 ? `${page}/${pages} back  ` : ''
  // Two spaces after the name too: the cursor sitting against the fill read as
  // part of it, and a field you cannot see the edge of is a field you hesitate
  // over.
  const bare = theme.fill === 'hairline'
  // The gutter mark stands in for the fill: one column saying whose prompt
  // this is and whether it has the keyboard, instead of two painted bands
  // saying the same thing across the width of the screen.
  const used = widthOf(label) + (bare ? 4 : 2) + shown + widthOf(where)
  const ground = focused ? mix(colour, theme.surface, 0.7) : mix(colour, theme.surface, 0.92)

  // The name on the first row and blanks under it: a field several rows tall
  // with the name repeated down its left edge reads as several fields.
  const named = (at: number) =>
    bare ? (
      <Text>
        <Text color={focused ? theme.accent : theme.faint} bold>
          {at === 0 && focused ? `${GUTTER.ask} ` : '  '}
        </Text>
        <Text color={focused ? colour : mix(colour, theme.surface, 0.5)} bold>
          {at === 0 ? label.trim() : ' '.repeat(widthOf(label.trim()))}
        </Text>
      </Text>
    ) : (
      <Text backgroundColor={focused ? colour : mix(colour, theme.surface, 0.55)}>
        <Text color={theme.onVoice} bold>
          {at === 0 ? label : ' '.repeat(widthOf(label))}
        </Text>
      </Text>
    )

  return (
    <Box flexDirection="column">
      {rows.map((row, at) => {
        const lastRow = at === rows.length - 1
        // The keystrokes belong to the field, and the field is one thing
        // however many rows it occupies: the input lives on the last row,
        // where the cursor is, and the rows above it are drawn text.
        const spare = lastRow
          ? width - used
          : width - widthOf(label) - (bare ? 4 : 2) - widthOf(row)
        return (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: rows are positions, and they move together
            key={at}
            wrap="truncate-end"
          >
            {named(at)}
            <Text {...(bare ? {} : { backgroundColor: ground })}>
              <Text>{'  '}</Text>
              {lastRow && focused ? (
                <TextInput
                  value={row}
                  onChange={(text) => onDraft(withLastRow(draft, rows, text))}
                  onSubmit={() => onSend(draft)}
                  placeholder={placeholder}
                />
              ) : (
                <Text color={lastRow ? theme.faint : theme.text}>{lastRow ? idle : row}</Text>
              )}
              <Text>{' '.repeat(Math.max(0, spare))}</Text>
              {lastRow && where !== '' ? <Text color={theme.warn}>{where}</Text> : null}
            </Text>
          </Text>
        )
      })}
    </Box>
  )
}

/**
 * The whole draft, with its last visible row replaced by what was just typed.
 *
 * The field shows the draft folded, and edits arrive for the row the cursor is
 * on. Everything before that row is kept exactly as it was — including the
 * newlines the person typed, which folding does not tell apart from the ones
 * it invented, so the rows above are taken from the draft rather than
 * rebuilt from the fold.
 */
function withLastRow(draft: string, rows: string[], typed: string): string {
  const shownLast = rows[rows.length - 1] ?? ''
  if (!draft.endsWith(shownLast)) return typed
  return draft.slice(0, draft.length - shownLast.length) + typed
}

/** Choosing who to put side by side. */
function SplitPicker({
  agents,
  chosen: initial,
  rows,
  columns,
  linesFor,
  onDone,
  onCancel,
}: {
  agents: AgentSnapshot[]
  chosen: string[]
  rows: number
  columns: number
  linesFor(agentId: string): Line[]
  onDone(chosen: string[]): void
  onCancel(): void
}) {
  const theme = useTheme()
  const voice = useVoice()
  const [chosen, setChosen] = useState<Set<string>>(new Set(initial))
  const [cursor, setCursor] = useState(0)

  useInput((input, key) => {
    if (key.escape) onCancel()
    if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
    if (key.downArrow) setCursor((c) => Math.min(agents.length - 1, c + 1))
    if (input === ' ') {
      const agent = agents[cursor]
      if (!agent) return
      setChosen((current) => {
        const next = new Set(current)
        if (next.has(agent.id)) next.delete(agent.id)
        else next.add(agent.id)
        return next
      })
    }
    if (key.return && chosen.size > 0) onDone([...chosen])
  })

  return (
    <Box flexDirection="column" height={rows} paddingX={1}>
      <Box marginBottom={1}>
        <Text bold color={theme.accent}>
          side by side
        </Text>
        <Text color={theme.muted}> — pick who to watch</Text>
      </Box>

      <Surface
        width={columns - 2}
        rows={agents.map((agent, index) => ({
          ...(index === cursor ? { background: headerTint(voice(index), theme.surface) } : {}),
          segments: [
            { text: ' ' },
            { text: chosen.has(agent.id) ? '▪' : '▫', color: voice(index) },
            {
              text: ` ${agent.id}`,
              color: chosen.has(agent.id) ? voice(index) : theme.muted,
              bold: index === cursor,
            },
            { text: `  ${shortModel(agent.model)}`, color: theme.faint },
            {
              text: linesFor(agent.id).length > 0 ? `  ${linesFor(agent.id).length} lines` : '',
              color: theme.faint,
            },
          ],
        }))}
      />

      <Box flexGrow={1} />
      <Text color={theme.faint}>
        {chosen.size} chosen · {chosen.size > 2 ? 'shown as a grid' : 'shown as columns'}
      </Text>
      <Text color={theme.muted}>space include · enter show · esc cancel</Text>
    </Box>
  )
}

/**
 * A token count, in the width of a tab.
 *
 * Millions get their own unit. A long session reaches them — 1.8 million input
 * tokens on one agent here — and `1794.1k` is both harder to read than `1.8M`
 * and two columns wider than the tab it has to fit in, so it was silently
 * clipped away and the figure appeared not to exist at all.
 */
function tokens(count: number): string {
  // Nothing at all for an agent that has spent nothing. A dash standing in for
  // zero is a character you have to decode into an absence.
  if (count === 0) return ''
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`
  if (count >= 10_000) return `${Math.round(count / 1000)}k`
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

/**
 * What this agent runs on, in the space of a tab.
 *
 * An agent that is another coding program is named by the program: its "model"
 * is whatever that program chose today, which is its business and not
 * something to show as though we had picked it. The arrow says it is not a
 * model at all — it is a whole other agent, on its own subscription.
 */
function describe(agent: AgentSnapshot): string {
  return shortModel(agent.model)
}

/**
 * What an agent has spent, in and out.
 *
 * Both halves, because they are different money: input is mostly the
 * conversation being sent again and grows by itself, output is what the model
 * actually wrote. One total hides which of the two is running away.
 */
function spend(agent: AgentSnapshot): string {
  const into = agent.usage.inputTokens + (agent.usage.cacheReadTokens ?? 0)
  const out = agent.usage.outputTokens
  if (into + out === 0) return ''
  return `↑${tokens(into) || '0'} ↓${tokens(out) || '0'}`
}

/**
 * The model, and every so often what it has cost in tokens instead.
 *
 * Alternating rather than side by side: a tab is fourteen columns and both at
 * once means neither is readable. Padded to whichever is longer so the marks
 * after it — asking, unread, behind — do not shuffle sideways twice a minute,
 * which is the kind of movement the eye chases and the mind cannot ignore.
 */
function badge(agent: AgentSnapshot, showingSpend: boolean): string {
  const model = describe(agent)
  const spent = spend(agent)
  if (spent === '') return model

  const width = Math.max(model.length, spent.length)
  return (showingSpend ? spent : model).padEnd(width)
}

/**
 * The part of a model name that distinguishes it.
 *
 * Names are mostly vendor and version, and in a column fourteen wide the whole
 * string is ellipsis. What identifies a model is the front of it.
 */
function shortModel(model: string): string {
  const bare = model.includes('/') ? (model.split('/').pop() ?? model) : model
  return bare.replace(/-(?:free|contributor|latest)$/, '')
}
