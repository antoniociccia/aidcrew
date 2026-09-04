import { existsSync, mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Decision } from '@aidcrew/cli'
import {
  attach,
  copyToClipboard,
  keyForProvider,
  scopeFor,
  setSharedMemory,
  setSourcePaths as setSourcePathsInConfig,
} from '@aidcrew/cli'
import type { AgentDef, AgentSnapshot, Contention, MergeOutcome, Task } from '@aidcrew/core'
import { ORCHESTRATION, ORCHESTRATION_FILE, readTasks, tokensOf } from '@aidcrew/core'
import { Box, Text, useApp } from 'ink'
import { useEffect, useRef, useState } from 'react'
import type { AgentTemplate } from './agents-file.ts'
import { removeAgent, toTemplate, writeAgent } from './agents-file.ts'
import { answersFor } from './answers.ts'
import { isDirectory, projectFiles } from './browse.ts'
import type { Command } from './commands.ts'
import { COMMANDS, parseCommand } from './commands.ts'
import type { SessionNotice } from './components/notice.tsx'
import { listModels } from './models.ts'
import type { Notice } from './notices.ts'
import { askingNotice, noticeFor, seeing, total, unseenBy } from './notices.ts'
import { oneAtATime } from './one-at-a-time.ts'
import { setAgentModel } from './project-config.ts'
import type { LiveTeam, Runtime, SourceKind } from './runtime.ts'
import { readProject, startTeam } from './runtime.ts'
import { Keys } from './screens/keys.tsx'
import { Notices } from './screens/notices.tsx'
import { Opening } from './screens/opening.tsx'
import type { Line, Pending } from './screens/session.tsx'
import { Session } from './screens/session.tsx'
import { Settings } from './screens/settings.tsx'
import { Tasks } from './screens/tasks.tsx'
import { TeamEditor } from './screens/team-editor.tsx'
import { Tour } from './screens/tour.tsx'
import type { WizardResult } from './screens/wizard.tsx'
import { Wizard } from './screens/wizard.tsx'
import { Workspaces } from './screens/workspaces.tsx'
import { GRAPHITE, loadThemes, themeNamed } from './theme.ts'
import { ThemeProvider } from './theme-context.tsx'
import type { UiState } from './ui-state.ts'
import { EMPTY, inOrder, readUiState, writeUiState } from './ui-state.ts'

/**
 * Which screen is showing, and what carries between them.
 *
 * A plain state machine rather than a router: there are five screens, they
 * form a shallow tree, and anything more would be scaffolding around a
 * problem this size does not have.
 */

type Screen =
  | { at: 'loading' }
  /** The guided tour, shown after a first run and reachable with /tour. */
  | { at: 'tour'; cwd: string }
  | { at: 'workspaces' }
  | { at: 'wizard'; cwd: string }
  | { at: 'session'; cwd: string }
  | { at: 'settings'; cwd: string }
  | { at: 'team'; cwd: string }
  | { at: 'notices'; cwd: string }
  | { at: 'keys'; cwd: string; because?: string }
  | { at: 'tasks'; cwd: string }

export type AppProps = {
  runtime: Runtime
  home: string
  env: Record<string, string | undefined>
  /** Where to start, when the command line named a directory. */
  initialCwd?: string
}

/**
 * What an agent is told when you ask it for a plugin.
 *
 * Written here rather than left to whoever is at the keyboard: the contract is
 * small but exact, and an agent that has to guess at it produces a plugin that
 * loads and then does nothing. Everything a plugin can be is in this brief.
 */
const PLUGIN_BRIEF = `Write me an aidcrew plugin.

A plugin is one TypeScript module that default-exports definePlugin({...}) from
@aidcrew/plugin-sdk. It can supply any combination of five things, all
optional: tools, providers, loaders, hooks, ui. Nothing else is a plugin, and
the core knows about none of them by name.

Put it in .aidcrew/plugins/<name>/index.ts in this project. It is loaded from
there on the next start; nothing has to be registered anywhere else.

Before writing anything: read packages/plugin-sdk/src to see the exact shapes,
and read one plugin in plugins/ that is closest to what I asked for — tool-fs
for a tool, provider-openai-compat for a provider, loader-claude for a loader.
Follow their conventions rather than inventing your own.

Then ask me what the plugin should do, unless I have already said. Write a
failing test first, then the plugin, then run bun test and bunx tsc --noEmit
and make them pass.`

export function App({ runtime, home, env, initialCwd }: AppProps) {
  const [themeName, setThemeName] = useState(runtime.store.get('theme'))
  const [fill, setFill] = useState(runtime.store.get('theme.fill'))
  const themes = loadThemes(home)
  // Two settings, because they are two questions: which palette, and how much
  // of the screen it paints. Absent means whatever the palette itself
  // suggests, so somebody who has only ever chosen a palette keeps what they
  // chose.
  const theme = themeNamed(themes, themeName, fill as never)
  const { exit } = useApp()
  const [screen, setScreen] = useState<Screen>({ at: 'loading' })
  const [agents, setAgents] = useState<AgentDef[]>([])
  const [snapshots, setSnapshots] = useState<AgentSnapshot[]>([])
  /** Work handed over that nobody is going to do, while that is true. */
  const [stall, setStall] = useState<SessionNotice | undefined>(undefined)
  // One question on screen at a time. Two agents asking in the same second
  // used to leave the first one waiting for ever on a prompt that had been
  // drawn over.
  const askOne = useRef(oneAtATime()).current
  /** The order the tabs were dragged into, remembered per project. */
  const [order, setOrder] = useState<string[]>([])
  const [lines, setLines] = useState<Line[]>([])
  const [target, setTarget] = useState('')
  const [team, setTeam] = useState<LiveTeam | undefined>()
  /** Why the last attempt to open a project did not work, for the list. */
  const [openFailure, setOpenFailure] = useState<string | undefined>()
  const [known, setKnown] = useState(runtime.store.knownSecrets())
  // Whatever an agent is waiting on a person for — a tool call to approve, a
  // busy colleague to decide about. One at a time: two questions drawn at once
  // would be two agents stopped and no way to tell which key answers which.
  const [pending, setPending] = useState<Pending | undefined>()

  const [defaults, setDefaults] = useState<{ provider?: string; model?: string }>({
    ...(runtime.store.get('default.provider')
      ? { provider: runtime.store.get('default.provider') as string }
      : {}),
    ...(runtime.store.get('default.model')
      ? { model: runtime.store.get('default.model') as string }
      : {}),
  })
  const [sourcePaths, setSourcePaths] = useState<{ label: SourceKind; paths: string[] }[]>([])
  const [layout, setLayout] = useState<UiState>(EMPTY)
  /** Every file in the project, for completing a name typed with `@`. */
  const [files, setFiles] = useState<string[]>([])
  /** The jobs this repository has open, read from git when the list is opened. */
  const [tasks, setTasks] = useState<Task[]>([])
  /** The task being worked in, which is what a new agent joins. */
  const [current, setCurrent] = useState('main')

  /** Runs git in a directory, which is all `readTasks` needs of the world. */
  const runGit =
    (cwd: string) =>
    async (args: string[], at?: string): Promise<string> => {
      const child = Bun.spawn(['git', ...args], {
        cwd: at ?? cwd,
        stdout: 'pipe',
        stderr: 'ignore',
      })
      return await new Response(child.stdout as ReadableStream<Uint8Array>).text()
    }

  /** Asks git what is open, rather than remembering: a worktree outlives us. */
  async function refreshTasks(cwd: string): Promise<void> {
    if (cwd === '') return
    setTasks(await readTasks(cwd, runGit(cwd)))
  }

  /**
   * Moves the team to another job.
   *
   * The agents already running stay where they are — they have a conversation
   * and a checkout, and dragging either across would lose one of them. What
   * changes is where the next agent goes.
   */
  async function moveTo(name: string): Promise<void> {
    setCurrent(name)
    const already = snapshots.some((agent) => agent.task === name)
    if (already) {
      const first = snapshots.find((agent) => agent.task === name)
      if (first) setTarget(first.id)
      return
    }
    const started = await team?.startTask(name, [])
    if (started?.[0]) setTarget(started[0])
  }
  // What happened while you were looking somewhere else. Built from the lines
  // as they arrive rather than stored alongside them, so there is one record
  // of what happened and two ways of reading it.
  const [notices, setNotices] = useState<Notice[]>([])
  const seenUpTo = useRef(0)
  const nextNotice = useRef(0)
  /** Notice ids, which only have to be different from each other and rising. */
  const idForNotice = () => {
    nextNotice.current += 1
    return nextNotice.current
  }
  // Where this project says how its team works. Held rather than re-read,
  // because starting a session must not depend on which function happens to
  // have the project object in scope.
  const [orchestration, setOrchestration] = useState<string[]>([])
  /** Who leads this team, and therefore cannot be taken off it. */
  const [leader, setLeader] = useState<string | undefined>()
  /** Tool calls one turn may make, when the project says so. */
  const [turnBound, setTurnBound] = useState<number | undefined>(undefined)
  /** How a job is proved and brought home, when the project says. */
  const [doneRules, setDoneRules] = useState<{
    check?: string | undefined
    mergeOnDone?: boolean | undefined
  }>({})
  const [projectPrices, setProjectPrices] = useState<
    Record<string, { input: number; output: number }>
  >({})
  /** Whether the team on a task keeps a note the others can read. */
  const [sharedNotes, setSharedNotes] = useState(false)
  /** Whether absolute paths are kept off the screen, for a shared screen. */
  const [hidden, setHidden] = useState(runtime.store.get('hide.paths') === 'yes')

  /** Says something in the pane of the agent it concerns, without a model. */
  function say(agentId: string, text: string): void {
    setLines((held) => [...held, { agentId, kind: 'note', text }])
  }

  /**
   * An async handler whose failure is shown rather than dropped.
   *
   * The screens call these with `void`, which is the right shape — a keypress
   * does not wait for a filesystem — but it also means a thrown error goes
   * nowhere at all. Adding an agent that had no key did exactly this: the
   * write happened, the spawn threw, and the interface simply did not change,
   * which read as "nothing works and nothing refreshes".
   */
  function guarded<A extends unknown[]>(
    handler: (...args: A) => Promise<void>,
  ): (...args: A) => Promise<void> {
    return async (...args: A) => {
      try {
        await handler(...args)
      } catch (error) {
        setLines((held) => [
          ...held,
          {
            agentId: target,
            kind: 'error',
            text: error instanceof Error ? error.message : String(error),
          },
        ])
      }
    }
  }

  /**
   * A typed line: a command if it is one, otherwise something to say.
   *
   * Commands are answered in the pane they were typed in rather than on a
   * screen of their own. What you asked and what happened belong in the same
   * column as the work, which is the only place you will look for them later.
   */
  async function run(text: string): Promise<void> {
    const command = parseCommand(text)
    if (!command || !team) {
      // Files named with @ are read here and sent with the message, rather
      // than left for the agent to go and fetch — which is a whole turn, and
      // a request, for something you already had open.
      const cwd = screen.at === 'session' ? screen.cwd : process.cwd()
      const { text: whole, missing } = await attach(text, cwd)
      if (missing.length > 0) {
        say(target, `could not read ${missing.join(', ')} — sent the message without it`)
      }
      await team?.tell(target, whole)
      return
    }

    try {
      await carry(command)
    } catch (cause) {
      say(target, cause instanceof Error ? cause.message : String(cause))
    }
  }

  async function carry(command: Command): Promise<void> {
    if (!team) return

    switch (command.at) {
      case 'help':
        for (const entry of COMMANDS) {
          say(target, `/${entry.name} ${entry.args}`.padEnd(26) + entry.what)
        }
        return

      case 'spawn': {
        const id = await team.spawn(command.role, {
          ...(command.provider ? { provider: command.provider } : {}),
          ...(command.model ? { model: command.model } : {}),
        })
        // Moved to, because spawning one is nearly always followed by telling
        // it something, and hunting for the tab it landed in is friction.
        setTarget(id)
        return
      }

      case 'kill': {
        if (!snapshots.some((agent) => agent.id === command.agent)) {
          say(target, `no agent called "${command.agent}"`)
          return
        }
        const { workspace } = await team.kill(command.agent)
        // The leader stays, and the host has already said so; announcing
        // that it is gone on top of that was a lie one line under the truth.
        if (team.snapshots().some((agent) => agent.id === command.agent)) return
        say(
          target,
          workspace === 'kept'
            ? `${command.agent} is gone. Its checkout stays: there is work in it that is nowhere else.`
            : `${command.agent} is gone, worktree and all`,
        )
        return
      }

      case 'tell':
        await team.tell(command.agent, command.text)
        return

      case 'task': {
        const started = await team.startTask(command.name, command.roles)
        // Moved to the first of them, because starting a job is nearly always
        // followed by telling it what the job is.
        if (started[0]) setTarget(started[0])
        else say(target, `nothing started for "${command.name}"`)
        return
      }

      case 'copy': {
        const who = command.agent ?? target
        // What is on screen is clipped to the pane; what goes on the
        // clipboard is what was actually said.
        const said = lines
          .filter((line) => line.agentId === who)
          .map((line) => line.text)
          .join('\n')

        if (said === '') {
          say(target, `${who} has not said anything yet`)
          return
        }
        const done = await copyToClipboard(said)
        say(
          target,
          done
            ? `copied ${said.split('\n').length} lines from ${who}`
            : 'no clipboard command on this machine — tried pbcopy, wl-copy, xclip, xsel',
        )
        return
      }

      case 'diff': {
        const who = command.agent ?? target
        const patch = await team.diff(who)
        say(who, patch.trim() === '' ? 'nothing changed yet' : patch)
        return
      }

      case 'merge': {
        const who = command.agent ?? target
        const outcome = await team.merge(who)
        say(who, mergeSaid(outcome))
        return
      }

      case 'stop':
        team.cancel(command.agent ?? target)
        return

      case 'clear': {
        const who = command.agent ?? target
        if (!team.forget(who)) {
          say(target, `${who} is in the middle of a turn — "/stop ${who}" first.`)
        }
        return
      }

      case 'drop':
        team.clearQueue(command.agent ?? target)
        return

      case 'yolo': {
        const who = command.agent ?? target
        if (!team.setYolo(who, command.on)) say(target, `no agent called "${who}"`)
        return
      }

      case 'model': {
        // Written down and done, rather than written down and announced. This
        // used to save the choice and tell you to restart, while the same
        // change made through the team editor took effect at once — two ways
        // to say one thing, of which only one worked.
        const to = {
          model: command.model,
          ...(command.provider ? { provider: command.provider } : {}),
        }
        await setAgentModel(screen.at === 'session' ? screen.cwd : '', target, to)
        const moved = team.setModel(target, to)
        setSnapshots(team.snapshots())
        say(
          target,
          moved
            ? `${target} is on ${command.model}${command.provider ? ` at ${command.provider}` : ''} from its next turn`
            : `no agent called "${target}"`,
        )
        return
      }

      case 'tour':
        setScreen({ at: 'tour', cwd: screen.at === 'session' ? screen.cwd : process.cwd() })
        return

      case 'split':
        say(target, 'press ^l to choose which agents are shown side by side')
        return

      case 'mcp':
        say(
          target,
          'run `aidcrew mcp` in a terminal: a server is a program, and trusting one is not something to do mid-task',
        )
        return

      case 'unknown':
        say(
          target,
          command.nearest
            ? `no such command ${command.typed} — did you mean /${command.nearest}?`
            : `no such command ${command.typed}. /help lists them.`,
        )
        return
    }
  }

  /**
   * Says a thing once, however many times it happens.
   *
   * For failures that repeat every frame: a plugin with a bug in its
   * interface code fails sixty times a second, and sixty identical lines say
   * nothing the first one did not.
   */
  const complained = useRef(new Set<string>())
  function complainOnce(text: string): void {
    if (complained.current.has(text)) return
    complained.current.add(text)
    setLines((held) => [...held, { agentId: target, kind: 'error', text }])
  }

  /**
   * Loads a project and decides whether it needs setting up first.
   *
   * Anything that goes wrong comes back to the list of projects with the
   * reason on it. Without this the screen sat on "opening" forever — one
   * unparseable line in a config file and the interface simply stopped, with
   * nothing to read and nothing to press.
   */
  async function open(cwd: string): Promise<void> {
    try {
      await openOrThrow(cwd)
    } catch (error) {
      setOpenFailure(`${cwd}: ${error instanceof Error ? error.message : String(error)}`)
      setScreen({ at: 'workspaces' })
    }
  }

  async function openOrThrow(cwd: string): Promise<void> {
    setScreen({ at: 'loading' })
    setOpenFailure(undefined)

    // Made rather than demanded. Naming a project used to require going away,
    // creating the directory and coming back — and the screen that asked for
    // one refused every path that was not already there, which is the whole
    // of what "start a new project" means.
    mkdirSync(cwd, { recursive: true })
    runtime.store.rememberWorkspace(cwd)

    const project = await readProject(runtime, cwd, home, env)
    setAgents(project.agents)
    setSourcePaths(project.sources)
    const remembered = readUiState(cwd)
    setLayout(remembered)
    setOrder(remembered.order)
    // Read once, in the background: a person types faster than a filesystem
    // walks, and a suggestion that arrives after the next keystroke is one
    // nobody sees. Four milliseconds on this repository.
    void projectFiles(cwd).then(setFiles)
    setProjectPrices(project.config.prices)
    setOrchestration(project.config.sources.orchestration)
    setLeader(project.config.leader)
    setTurnBound(project.config.toolCallsPerTurn)
    setDoneRules({ check: project.config.check, mergeOnDone: project.config.mergeOnDone })
    setSharedNotes(project.config.sharedMemory)

    // A project with no agents, or no key to run them, needs the wizard —
    // dropping someone into an empty session would leave them nowhere to go.
    const needsSetup =
      project.agents.length === 0 || project.blocked.length === project.agents.length
    if (needsSetup) {
      setScreen({ at: 'wizard', cwd })
      return
    }

    await enterSession(cwd, project.agents)
  }

  async function enterSession(cwd: string, members: AgentDef[]): Promise<void> {
    await team?.shutdown()

    // Declared before it is built, because `onChange` below runs before this
    // assignment does: startTeam spawns the agents, spawning emits events, and
    // events announce. Reaching for `live` from inside the callback threw
    // `Cannot access before initialization` once per agent — five agents, five
    // stack traces down the terminal before the first frame was drawn. The
    // session started anyway, since the runtime guards the callback, which is
    // what let it go unnoticed.
    // Trust given for an afternoon, given back — as the agents are made
    // rather than after, so that it is how they start and not a change
    // announced on every opening. Forgetting it would mean an agent you
    // deliberately turned loose starts asking again on the next turn.
    const saved = readUiState(cwd)
    const loose = new Set(saved.unleashed)

    let live: LiveTeam | undefined
    live = await startTeam({
      orchestration,
      ...(leader ? { leader } : {}),
      ...(turnBound ? { toolCallsPerTurn: turnBound } : {}),
      ...(doneRules.check ? { check: doneRules.check } : {}),
      ...(doneRules.mergeOnDone === false ? { mergeOnDone: false } : {}),
      runtime,
      cwd,
      env,
      agents: members.map((member) => (loose.has(member.id) ? { ...member, yolo: true } : member)),
      defaultProvider: defaults.provider ?? 'zen',
      prices: projectPrices,
      skills: [],
      ...(sharedNotes ? { sharedMemory: true } : {}),
      onChange: (nextLines, nextSnapshots) => {
        setLines(nextLines)
        setSnapshots(nextSnapshots)
        // Asked on the beat that already exists, which is the moment
        // something last happened — and the moment a team stops is the
        // moment after the last thing it did. It answers nothing while
        // anybody is still working, so this cannot fire over a turn in
        // flight.
        // Nothing has stalled while the team is still being built, so an
        // absent one is an answer rather than a gap.
        setStall(live?.stalled())

        // Only what has arrived since last time: rebuilding from the whole
        // transcript would resurrect notices you had already read.
        const fresh = nextLines
          .slice(seenUpTo.current)
          .map((line) => noticeFor(line, idForNotice(), Date.now()))
          .filter((notice): notice is Notice => notice !== undefined)
        seenUpTo.current = nextLines.length
        if (fresh.length > 0) setNotices((held) => [...held, ...fresh])
      },
      // The agent's turn waits on this promise, so the work genuinely stops
      // until somebody answers rather than racing ahead of the question.
      onApproval: (request) =>
        askOne(
          () =>
            new Promise<Decision>((resolve) => {
              // Brought into view as well as recorded. The question is drawn in
              // the pane of the agent that asked it, so one asking while you look
              // at another produced a screen with no question on it — and the
              // agent waited on an answer nobody could give.
              if (request.agentId !== '') setTarget(request.agentId)
              setNotices((held) => [
                ...held,
                askingNotice(request.agentId, request.summary, idForNotice(), Date.now()),
              ])
              const answer = (decision: Decision) => () => {
                setPending(undefined)
                resolve(decision)
              }

              setPending({
                agentId: request.agentId,
                because: request.because,
                summary: request.summary,
                answers: answersFor(request.scopes, answer),
                safe: 'n',
              })
            }),
        ),

      // One agent sending work to another that is already busy. Queuing it is
      // what a mailbox does unasked, and by the time it is read the repository
      // has moved — so the choice is put where somebody can see what else is
      // running and what a second agent would cost.
      onContention: (request) =>
        askOne(
          () =>
            new Promise<Contention>((resolve) => {
              setTarget(request.to)
              setNotices((held) => [
                ...held,
                askingNotice(
                  request.to,
                  `busy — ${request.from} is waiting`,
                  idForNotice(),
                  Date.now(),
                ),
              ])

              const answer = (at: Contention['at']) => () => {
                setPending(undefined)
                resolve({ at } as Contention)
              }

              setPending({
                agentId: request.to,
                because: `is busy, and ${request.from} sent work`,
                summary: request.text,
                answers: [
                  { key: 'w', label: 'wait', tone: 'ok', take: answer('queue') },
                  {
                    key: 's',
                    label: `spawn a second ${request.to}`,
                    tone: 'warn',
                    take: answer('spawn'),
                  },
                  { key: 'd', label: 'drop it', tone: 'bad', take: answer('drop') },
                ],
                safe: 'w',
              })
            }),
        ),
    })

    setTeam(live)
    setSnapshots(live.snapshots())

    // The job that was open, and the agents that were on it. A worktree
    // outlives the session that made it, so leaving one half-done and coming
    // back to it is the normal way to use them — and reopening on the main
    // task instead is a way to do an afternoon's work in the wrong directory.
    setCurrent(saved.task)
    if (saved.task !== 'main') await live.startTask(saved.task, [])

    // Back to whoever was being addressed last time, if they are still on the
    // team: the agent you were talking to is part of where you left off.
    const roster = live.snapshots()
    const known = roster.some((agent) => agent.id === saved.target)
    setTarget(known ? saved.target : (roster[0]?.id ?? members[0]?.id ?? ''))
    setSnapshots(live.snapshots())
    setScreen({ at: 'session', cwd })
    void refreshTasks(cwd)
  }

  async function finishWizard(cwd: string, result: WizardResult): Promise<void> {
    runtime.store.set('default.provider', result.provider)
    runtime.store.set('default.model', result.model)

    for (const { template } of result.agents) await writeAgent(cwd, template)

    // Written only when it was asked for, and never over one that is already
    // there: a project that has an ORCHESTRATE.md has one somebody wrote.
    if (result.writeOrchestration) {
      const path = join(cwd, ORCHESTRATION_FILE)
      if (!existsSync(path)) await writeFile(path, `${ORCHESTRATION.trim()}\n`, 'utf8')
    }

    setKnown(runtime.store.knownSecrets())
    const project = await readProject(runtime, cwd, home, env)
    setAgents(project.agents)
    setSourcePaths(project.sources)
    const remembered = readUiState(cwd)
    setLayout(remembered)
    setOrder(remembered.order)
    setProjectPrices(project.config.prices)
    setOrchestration(project.config.sources.orchestration)
    setLeader(project.config.leader)
    setTurnBound(project.config.toolCallsPerTurn)
    setDoneRules({ check: project.config.check, mergeOnDone: project.config.mergeOnDone })
    setSharedNotes(project.config.sharedMemory)
    await enterSession(cwd, project.agents)
    // The team exists; now what a team is for. A first run used to end at a
    // cursor, with nothing having said what happens when two agents want the
    // same file or where the work goes.
    setScreen({ at: 'tour', cwd })
  }

  /** The key a provider would use, for asking it what models it has. */
  async function keyFor(providerId: string): Promise<string | undefined> {
    const resolved = keyForProvider(providerId, { env, store: runtime.store })
    return resolved?.apiKey
  }

  async function saveKey(scope: string, apiKey: string): Promise<void> {
    runtime.store.setCredential(scope, { apiKey })
    setKnown(runtime.store.knownSecrets())
  }

  // biome-ignore lint/correctness/useExhaustiveDependencies: opening once is the point
  useEffect(() => {
    void (initialCwd ? open(initialCwd) : setScreen({ at: 'workspaces' }))
    // Runs once: opening a project is a deliberate act, not a reaction to a
    // value changing. Listing the directory here would reopen the project
    // underneath somebody who had navigated away from it.
  }, [])

  const wrap = (content: React.ReactNode) => <ThemeProvider value={theme}>{content}</ThemeProvider>

  if (screen.at === 'loading') {
    return wrap(<Opening />)
  }

  if (screen.at === 'tour') {
    return wrap(<Tour onClose={() => setScreen({ at: 'session', cwd: screen.cwd })} />)
  }

  if (screen.at === 'workspaces') {
    return wrap(
      <Workspaces
        known={runtime.store.workspaces()}
        {...(openFailure ? { failure: openFailure } : {})}
        onOpen={(path) => void open(path)}
        cwd={initialCwd ?? process.cwd()}
        home={home}
        onForget={(path) => {
          runtime.store.forgetWorkspace(path)
          setScreen({ at: 'workspaces' })
        }}
        onForgetAll={() => {
          for (const workspace of runtime.store.workspaces()) {
            runtime.store.forgetWorkspace(workspace.path)
          }
          setScreen({ at: 'workspaces' })
        }}
        onCancel={exit}
        exists={isDirectory}
        validate={async (path) =>
          // A path that is not there yet is fine — it is about to be made.
          // What is refused is a path that exists and is not a directory,
          // which is the one case opening it cannot recover from.
          //
          // `Bun.file()` describes a file and answers false for every
          // directory there has ever been, so an earlier version of this
          // refused all of them: the screen for opening a project could not
          // open a project.
          !existsSync(path) || isDirectory(path)
            ? { ok: true }
            : { ok: false, reason: `${path} is a file, not a directory` }
        }
      />,
    )
  }

  if (screen.at === 'wizard') {
    return wrap(
      <Wizard
        providers={runtime.providers}
        saveKey={(providerId, apiKey) => saveKey(scopeFor('provider', providerId), apiKey)}
        listModels={async (providerId, apiKey) => {
          const definition = runtime.host.registry.provider(providerId)
          if (!definition) return { kind: 'unavailable', reason: 'unknown provider' }

          // Asked of the provider itself: a second copy of these URLs is what
          // made opencode-go work for requests and fail to list its models.
          const baseUrl = env.AIDCREW_BASE_URL ?? definition.endpoint
          return baseUrl
            ? listModels(baseUrl, apiKey)
            : { kind: 'unavailable', reason: `no endpoint declared for ${providerId}` }
        }}
        onDone={(result) => void guarded(() => finishWizard(screen.cwd, result))()}
        onCancel={exit}
      />,
    )
  }

  if (screen.at === 'settings') {
    return wrap(
      <Settings
        known={known}
        providers={runtime.providers}
        agents={agents.map((agent) => agent.id)}
        models={[...new Set(agents.map((agent) => agent.model).filter(Boolean))] as string[]}
        defaults={defaults}
        // Every palette in both fills. Which hues and how much is painted are
        // two settings underneath and one choice here: a list that showed only
        // the palettes hid the half of the choice it was offering.
        themes={themes.flatMap((one) => [
          { name: one.name, fill: 'hairline' as const },
          { name: one.name, fill: 'solid' as const },
        ])}
        theme={theme.name}
        plugins={runtime.host.registry.plugins().map((plugin) => ({
          name: plugin.name,
          version: plugin.version,
          tools: plugin.tools?.length ?? 0,
          providers: plugin.providers?.length ?? 0,
          loaders: plugin.loaders?.length ?? 0,
          hooks: plugin.hooks !== undefined,
        }))}
        sources={sourcePaths}
        cwd={screen.cwd}
        storePath={runtime.store.path}
        onSaveKey={saveKey}
        onForgetKey={async (scope) => {
          runtime.store.forgetSecret(scope)
          setKnown(runtime.store.knownSecrets())
        }}
        onSetDefault={(what, value) => {
          runtime.store.set(`default.${what}`, value)
          setDefaults((current) => ({ ...current, [what]: value }))
        }}
        onSetTheme={(name) => {
          runtime.store.set('theme', name)
          setThemeName(name)
        }}
        onSetFill={(next) => {
          runtime.store.set('theme.fill', next)
          setFill(next)
        }}
        hidePaths={hidden}
        onHidePaths={(on) => {
          setHidden(on)
          // Per person and per machine rather than per project: whether the
          // screen is being recorded is a fact about the room, not about the
          // repository.
          runtime.store.set('hide.paths', on ? 'yes' : 'no')
        }}
        sharedMemory={sharedNotes}
        onSharedMemory={(on) => {
          setSharedNotes(on)
          // Now, not at the next start: a setting somebody is switching in
          // order to see what it does has to do it while they are looking.
          team?.setSharedMemory(on)
          // And written to the project rather than to this machine, because
          // whether a team keeps notes is a property of how the work is done
          // there — the next person to clone it should inherit the answer.
          void guarded(() => setSharedMemory(screen.at === 'settings' ? screen.cwd : '', on))()
        }}
        onSetSources={(kind, paths) => {
          void guarded(async () => {
            await setSourcePathsInConfig(screen.cwd, kind, paths)
            setSourcePaths((current) =>
              current.map((one) => (one.label === kind ? { ...one, paths } : one)),
            )
          })()
        }}
        onWritePlugin={() => {
          setScreen({ at: 'session', cwd: screen.cwd })
          void guarded(async () => await team?.tell(target, PLUGIN_BRIEF))()
        }}
        onClose={() => setScreen({ at: 'session', cwd: screen.cwd })}
      />,
    )
  }

  if (screen.at === 'keys') {
    return wrap(
      <Keys
        {...(screen.because ? { because: screen.because } : {})}
        onClose={() => setScreen({ at: 'session', cwd: screen.cwd })}
      />,
    )
  }

  if (screen.at === 'notices') {
    return wrap(
      <Notices
        notices={notices}
        agents={snapshots.map((agent) => agent.id)}
        onGo={(agentId) => {
          // Only to somebody who is there: focusing a name that is not on
          // the team left the field with nothing to type into.
          if (snapshots.some((agent) => agent.id === agentId)) setTarget(agentId)
          setNotices((held) => seeing(held, agentId))
          setScreen({ at: 'session', cwd: screen.cwd })
        }}
        onClose={() => setScreen({ at: 'session', cwd: screen.cwd })}
      />,
    )
  }

  if (screen.at === 'tasks') {
    return wrap(
      <Tasks
        tasks={tasks}
        current={current}
        spentOn={(name) => {
          const usage = team?.spentByTask().get(name)
          if (!usage) return undefined
          const total = tokensOf(usage)
          return total === 0 ? undefined : `${Math.round(total / 1000)}k tokens`
        }}
        onChoose={(name) => {
          void guarded(() => moveTo(name))()
          setScreen({ at: 'session', cwd: screen.cwd })
        }}
        onNew={() => {
          // A name is what a task needs and the list cannot supply, so this
          // goes back to the field where names get typed.
          setScreen({ at: 'session', cwd: screen.cwd })
          say(target, 'name it: /task <name> [roles...]')
        }}
        onClose={() => setScreen({ at: 'session', cwd: screen.cwd })}
      />,
    )
  }

  if (screen.at === 'team') {
    return wrap(
      <TeamEditor
        agents={agents}
        providers={runtime.providers}
        onAdd={guarded(async (template: AgentTemplate) => {
          await writeAgent(screen.cwd, template)

          // On the same service as the people it is joining. A new agent used
          // to fall back to the machine's default provider, which on a project
          // running somewhere else is a provider with no key: it appeared in
          // the editor, failed to start, and could not be picked anywhere.
          const alongside = agents.find((agent) => agent.id === target) ?? agents[0]
          if (alongside?.provider) {
            await setAgentModel(screen.cwd, template.id, {
              provider: alongside.provider,
              ...(alongside.model ? { model: alongside.model } : {}),
            })
          }

          const project = await readProject(runtime, screen.cwd, home, env)
          setAgents(project.agents)

          // Started, not merely written down. Adding an agent used to update
          // the list on this screen and nothing else: you went back to the
          // session and there was no tab, because the team running had been
          // built before the agent existed.
          const added = project.agents.find((agent) => agent.id === template.id)
          if (!added) throw new Error(`${template.id} was written but not read back`)
          if (team) {
            await team.join(added)
            setSnapshots(team.snapshots())
            setTarget(added.id)
          }
          setScreen({ at: 'session', cwd: screen.cwd })
        })}
        onRemove={guarded(async (id: string) => {
          // Stopped first, and only then taken off the team on disk: the
          // leader cannot be stopped, and deleting its file while it kept
          // running meant it was there today and gone at the next start,
          // with nothing said.
          if (team) {
            await team.kill(id)
            setSnapshots(team.snapshots())
            if (team.snapshots().some((agent) => agent.id === id)) {
              throw new Error(`${id} leads this team and stays on it`)
            }
          }
          await removeAgent(screen.cwd, id)
          const project = await readProject(runtime, screen.cwd, home, env)
          setAgents(project.agents)
        })}
        listModels={async (providerId) => {
          const definition = runtime.host.registry.provider(providerId)
          if (!definition?.endpoint) {
            return { kind: 'unavailable', reason: `no endpoint declared for ${providerId}` }
          }
          const key = await keyFor(providerId)
          return key
            ? listModels(env.AIDCREW_BASE_URL ?? definition.endpoint, key)
            : { kind: 'unavailable', reason: `no key saved for ${providerId}` }
        }}
        onSetModel={guarded(async (id: string, provider: string, model: string) => {
          await setAgentModel(screen.cwd, id, { provider, model })
          const project = await readProject(runtime, screen.cwd, home, env)
          setAgents(project.agents)

          // The agent running still has the old model until it is told: a
          // model chosen here used to change the file and nothing else, so
          // the tab kept showing what it was and the next turn went to the
          // service you had just moved away from.
          //
          // Told, not restarted. This killed the agent and started it again,
          // which threw away its conversation — and was refused for the
          // leader, so the agent most often moved to a better model was the
          // one that silently stayed on the old one and failed on its next
          // turn.
          const changed = project.agents.find((agent) => agent.id === id)
          if (changed && team) {
            if (!team.setModel(id, { provider, model })) await team.join(changed)
            setSnapshots(team.snapshots())
          }
        })}
        onClose={() => setScreen({ at: 'session', cwd: screen.cwd })}
      />,
    )
  }

  return wrap(
    <Session
      workspace={screen.cwd.split('/').at(-1) ?? screen.cwd}
      agents={inOrder(snapshots, order)}
      lines={lines}
      target={target}
      onTarget={(agentId) => {
        // Looking at a pane is what reading its notices means; asking you to
        // dismiss them as well would be asking you to tell the interface
        // something it can see you doing.
        setTarget(agentId)
        setNotices((held) => seeing(held, agentId))
      }}
      waiting={unseenBy(notices)}
      unseen={total(notices)}
      onOpenNotices={() => setScreen({ at: 'notices', cwd: screen.cwd })}
      onOpenKeys={(because) =>
        setScreen({ at: 'keys', cwd: screen.cwd, ...(because ? { because } : {}) })
      }
      onOpenTasks={() => {
        void refreshTasks(screen.at === 'session' ? screen.cwd : '')
        setScreen({ at: 'tasks', cwd: screen.at === 'session' ? screen.cwd : '' })
      }}
      onSend={(text) => void guarded(() => run(text))()}
      onOpenSettings={() => setScreen({ at: 'settings', cwd: screen.cwd })}
      onOpenAgents={() => setScreen({ at: 'team', cwd: screen.cwd })}
      onSwitchWorkspace={() => setScreen({ at: 'workspaces' })}
      onQuit={() => {
        void team?.shutdown().then(exit)
      }}
      pending={pending}
      files={files}
      hidePaths={hidden}
      extras={({ slot, agent }) =>
        runtime.host.registry.ui(
          {
            slot,
            ...(agent ? { agent } : {}),
            agents: snapshots,
            target,
            theme: theme as unknown as Record<string, string>,
            cwd: screen.at === 'session' ? screen.cwd : '',
          },
          // Said once in the pane being addressed, rather than every frame:
          // a plugin that throws on every redraw would otherwise fill the
          // transcript with the same line sixty times a second.
          (plugin, reason) => complainOnce(`${plugin}: ${reason}`),
        )
      }
      onClearQueue={(agentId) => team?.clearQueue(agentId)}
      onCancel={(agentId) => team?.cancel(agentId)}
      costOf={(agentId) => team?.prices.costOf(agentId)}
      // A guess about money, drawn as one. The bundled price list is what
      // gives a figure at all for a service that publishes none, and a guess
      // in the same type as a fact gets believed like one.
      estimated={(agentId) => team?.prices.estimated(agentId) === true}
      totalCost={() => team?.prices.total()}
      onPlan={() => team?.prices.split().listed}
      waitingOn={() => team?.outstanding() ?? 0}
      {...(stall ? { notice: stall } : {})}
      // The agent you are looking at, because the figure sits beside its name
      // and a plan belongs to the credential that agent runs on.
      allowance={team?.prices.allowance(target)}
      layout={layout}
      onReorder={setOrder}
      onLayout={(state) =>
        writeUiState(screen.cwd, {
          ...state,
          order,
          // The task and who is loose belong to the same record: they are all
          // "where I was", and writing them separately means a crash can save
          // half of it.
          task: current,
          unleashed: snapshots.filter((agent) => agent.yolo).map((agent) => agent.id),
        })
      }
    />,
  )
}

export function Fatal({ error }: { error: Error }) {
  return (
    <Box padding={1} flexDirection="column">
      <Text color={GRAPHITE.bad}>{error.message}</Text>
    </Box>
  )
}

export type { AgentTemplate }
export { toTemplate }

/** A merge's outcome in the words the pane shows. */
function mergeSaid(outcome: MergeOutcome): string {
  if (outcome.result === 'merged') return `merged into the repository: ${outcome.detail}`
  if (outcome.result === 'conflict') return `not merged — it conflicts:\n${outcome.detail}`
  return outcome.detail
}
