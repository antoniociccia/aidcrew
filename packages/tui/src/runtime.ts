import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { ApprovalRequest, Decision, Host, SettingsStore, WorkspaceConfig } from '@aidcrew/cli'
import {
  collectSources,
  createApprovalPlugin,
  createHost,
  createProvider,
  createTeamHost,
  HISTORY_FILE,
  hired,
  importDatabase,
  leaderOf,
  loadWorkspaceConfig,
  openHistory,
  openJournal,
  openStore,
  pluginDirectoriesFor,
  providerOptions,
  readOrchestration,
  refusalLine,
  reloadPlugins,
  resolveTeam,
  resolveTeamCredentials,
  trustedClaims,
  trustedPlugins,
  trustedServers,
} from '@aidcrew/cli'
import type {
  AgentDef,
  AgentSnapshot,
  Contention,
  ContentionRequest,
  Handoff,
  Hooks,
  MergeOutcome,
  Note,
  SetupOptions,
  TeamEvent,
  Usage,
} from '@aidcrew/core'
import { addUsage, DEFAULT_LIMITS, DEFAULT_MAX_HOPS } from '@aidcrew/core'
import { createCompactPlugin, DEFAULT_BUDGET, parseCompactWith } from '@aidcrew/hooks-compact'
import type { GuardRequest } from '@aidcrew/hooks-guard'
import type { Allowance, PriceTable } from '@aidcrew/prices'
import {
  allLeft,
  bundledPriceOf,
  costOf,
  crossings,
  fromConfig,
  isEstimate,
  loadAllowance,
  priceOf,
  refreshGate,
  splitOf,
  totalOf,
} from '@aidcrew/prices'
import { createSkillsPlugin } from '@aidcrew/tool-skills'
import type { SessionNotice } from './components/notice.tsx'
import type { Line } from './screens/session.tsx'
import { watchDirectories } from './watch.ts'

/**
 * Everything the interface needs from the rest of the system, behind one
 * object it can hold.
 *
 * The screens stay pure React: they take data and call functions. Anything
 * that touches a keychain, a filesystem or a model lives here, which is what
 * makes the screens renderable in a test without a machine underneath them.
 */

/**
 * What the guards need to know, filled in when a team starts.
 *
 * Held rather than passed because the host outlives the team: the interface
 * opens one and then opens and closes projects inside it.
 */
export type GuardSession = {
  trust(agentId: string): 'ask' | 'yolo'
  ask?(request: GuardRequest): Promise<boolean>
  /**
   * A plugin's own yes-or-no question, which is not a guard's.
   *
   * Kept apart from `ask` because a `GuardRequest` is about an agent calling a
   * tool: it carries an agent, a tool and a scope the answer can be widened
   * to. A plugin asking whether it may use the token in your keychain has
   * none of those, and inventing them would put three things on the prompt
   * that are not true — including an "always allow" that allows nothing.
   */
  askPlugin?(question: { plugin: string; title: string; detail?: string }): Promise<boolean>
  /** Where a plugin's news goes once there is a session to draw it in. */
  note?(text: string): void
}

export type Runtime = {
  /** What the guards consult, replaced as projects are opened. */
  session: GuardSession
  store: SettingsStore
  host: Host
  providers: string[]
  /** Where this user's own files live: settings, plugins, session records. */
  home: string
  /**
   * What plugins said while they were being set up, held until a session can
   * draw it. Emptied by `loadFailures`, which is where it is finally shown.
   */
  notes: string[]
  /**
   * What every plugin's `setup` is given, kept so a reload can hand over the
   * same thing the first load did.
   *
   * Held rather than rebuilt for the reason `pluginDirectoriesFor` is one
   * function: a reload that runs `setup` differently from the load is a
   * reload that silently changes what every plugin was configured with, and
   * saving the file you are working on is the moment it would happen.
   */
  setup: Partial<SetupOptions>
  close(): void
}

export async function openRuntime(cwd: string, home = homedir()): Promise<Runtime> {
  const store = openStore(home)
  // Read before the host, because a plugin's `setup` is handed its own
  // settings and runs while the host is being built.
  const settings = await loadWorkspaceConfig({
    cwd,
    home,
    // The config file arrived with the clone the same way a plugin does, and
    // was the door the plugin gate did not cover.
    trusted: trustedClaims(store, cwd),
  })

  // The guards belong to the host, so every path has them. What they need to
  // know — who is trusted, who to ask — is only known once a team is running,
  // so the host is given a way to look it up rather than the answers.
  const session: GuardSession = { trust: () => 'ask' }
  // What plugins said before there was a screen, and what this project's
  // config asked for and did not get. Read below, drawn later.
  const notes: string[] = settings.refused.map(refusalLine)
  // Straight into the session once there is one, and onto the pile until
  // then: a plugin keeps the host it was set up with and speaks again later
  // from a tool or a hook, and holding those until something else happened to
  // drain the pile would deliver news about a call long after the call.
  const say = (plugin: string, text: string): void => {
    // Named by the harness rather than by the plugin, so every plugin's news
    // reads the same way and none of them can sign somebody else's name.
    const line = `${plugin}: ${text}`
    if (session.note) session.note(line)
    else notes.push(line)
  }
  const setup: Partial<SetupOptions> = {
    // Each plugin's own table from the project config, and nobody else's.
    configFor: (name: string) => settings.plugins[name] ?? {},
    // Given here rather than only when a team starts, because a plugin is set
    // up while this host is being built and the contract says `ask` is present
    // whenever somebody is watching — and in the interface somebody always is.
    // Which prompt it reaches is looked up when the question is put, for the
    // same reason the guards look theirs up: the host outlives the team.
    ask: async (plugin, question) => {
      if (session.askPlugin) return await session.askPlugin({ ...question, plugin })
      // Nothing to ask on yet: setup runs before the first team, and a
      // question put then can only be answered no. Said out loud rather
      // than answered in silence, because a plugin that quietly did nothing
      // is a plugin you spend an afternoon on.
      say(
        plugin,
        `asked "${question.title}" while it was being set up, before there was anywhere to ` +
          'put the question, and was answered no. Ask from a tool or a hook instead, which ' +
          'run once somebody is here to answer.',
      )
      return false
    },
    say,
  }
  const host = await createHost({
    cwd,
    home,
    // Trust is given by typing `aidcrew mcp trust <server>`, never by a prompt
    // in the middle of something else — a server is a program, and a prompt
    // that interrupts is a prompt answered without reading.
    allowServer: trustedServers(store, cwd),
    // And for plugins, which run in this process with these keys rather than
    // beside it. `aidcrew plugin trust <name>`.
    allowPlugin: trustedPlugins(store, cwd),
    setup,
    guard: {
      trust: (agentId) => session.trust(agentId),
      ask: async (request) => (await session.ask?.(request)) ?? false,
    },
  })

  return {
    store,
    host,
    session,
    providers: host.registry.providers().map((provider) => provider.id),
    home,
    notes,
    setup,
    close: () => store.close(),
  }
}

/**
 * What could not be loaded, as lines somebody will actually see.
 *
 * The headless path has printed these to stderr since the beginning; the
 * interface dropped the list on the floor. A plugin that does not load is
 * otherwise completely invisible: you put the file there, nothing happens,
 * and there is nowhere to find out why — which is the worst possible first
 * experience for the one thing this project asks people to write.
 */
/**
 * Every hook the registry holds, in registration order.
 *
 * Read from the registry rather than assembled by the caller, so a reload
 * produces the same list a fresh start would — including the guards, which
 * have no privileged path into the loop and would simply be absent if this
 * ever forgot them.
 */
function hooksFor(host: Runtime['host']): Hooks[] {
  return host.registry
    .plugins()
    .map((plugin) => plugin.hooks)
    .filter((hooks): hooks is Hooks => hooks !== undefined)
}

export function loadFailures(runtime: Runtime, agentId: string): Line[] {
  return [
    // Refused first: it is the one with something to do about it.
    ...runtime.host.refused.map((candidate) => ({
      agentId,
      kind: 'note' as const,
      text:
        `this project offers a plugin called "${candidate.name}", which is not running. ` +
        `A plugin runs with your keys — "aidcrew plugin trust ${candidate.name}" if you want it.`,
    })),
    ...runtime.host.warnings.map((warning) => ({
      agentId,
      kind: 'note' as const,
      text: warning.reason,
    })),
    // What plugins said for themselves while they were being set up, which
    // happened before any of this could be drawn. Taken rather than copied:
    // this runs again after every reload, and news repeated on every save
    // reads as a plugin stuck in a loop.
    ...runtime.notes.splice(0, runtime.notes.length).map((text) => ({
      agentId,
      kind: 'note' as const,
      text,
    })),
    ...runtime.host.failures.map((failure) => ({
      agentId,
      kind: 'error' as const,
      text: `plugin not loaded (${failure.path}): ${failure.reason}`,
    })),
    ...runtime.host.serverFailures.map((failure) => ({
      agentId,
      kind: 'error' as const,
      text: `MCP server "${failure.name}": ${failure.reason}`,
    })),
  ]
}

export type SourceKind = 'instructions' | 'skills' | 'agents' | 'orchestration'

export type ProjectState = {
  config: WorkspaceConfig
  agents: AgentDef[]
  /** Agents that could not run, and why, so the interface can say so. */
  blocked: { agentId: string; providerId: string }[]
  /** Where instructions, skills and agents are read from, to show in settings. */
  sources: { label: SourceKind; paths: string[] }[]
}

/** Reads a project: its config, its agents and whether they can actually run. */
export async function readProject(
  runtime: Runtime,
  cwd: string,
  home: string,
  env: Record<string, string | undefined>,
): Promise<ProjectState> {
  // With what the person has allowed, which is the whole point of allowing
  // it. Read without this, a claim trusted with `aidcrew project trust` was
  // refused every time the team was built: the command said "trusted", the
  // command that lists them said "trusted", and the agent went on asking.
  const config = await loadWorkspaceConfig({
    cwd,
    home,
    trusted: trustedClaims(runtime.store, cwd),
  })
  const sources = await collectSources(runtime.host.registry.loaders(), config.sources)

  const defaultProvider = env.AIDCREW_PROVIDER ?? runtime.store.get('default.provider') ?? 'zen'
  const defaultModel = env.AIDCREW_MODEL ?? runtime.store.get('default.model')

  const { team } = resolveTeam(
    sources.agents,
    config.agents,
    { provider: defaultProvider, ...(defaultModel ? { model: defaultModel } : {}) },
    (id) => hired(sources.agentSources.get(id), cwd, home),
  )

  const credentials = resolveTeamCredentials(
    team,
    defaultProvider,
    { env, store: runtime.store },
    (providerId) => runtime.host.registry.provider(providerId)?.needsKey !== false,
  )

  return {
    config,
    agents: team,
    blocked: credentials.missing,
    sources: [
      { label: 'instructions', paths: config.sources.instructions ?? [] },
      { label: 'skills', paths: config.sources.skills ?? [] },
      { label: 'agents', paths: config.sources.agents ?? [] },
      { label: 'orchestration', paths: config.sources.orchestration ?? [] },
    ],
  }
}

export type Prices = {
  /**
   * What is left of the plan one agent's work goes through, when its service
   * says. Per agent because a plan belongs to a credential, and a team on two
   * services has two answers — one figure for the pair says neither.
   */
  allowance(agentId: string): string | undefined
  /** What one agent has spent, when anybody has said what its model costs. */
  costOf(agentId: string): number | undefined
  /**
   * Whether that figure is a list price rather than a bill.
   *
   * Drawn with a tilde in front when it is: a guess about money in the same
   * type as a fact gets believed like one.
   */
  estimated(agentId: string): boolean
  /** What the whole session has spent, of the agents that can be priced. */
  total(): number | undefined
  /**
   * What a payment method was charged and what came off a plan, apart.
   *
   * Only what a provider stated: a model priced from a table was billed to
   * nobody, and belongs to `total`.
   */
  split(): { charged?: number; listed?: number }
}

export type LiveTeam = {
  snapshots(): AgentSnapshot[]
  tell(agentId: string, text: string): Promise<void>
  /** Stops what an agent is doing now, leaving the agent standing. */
  cancel(agentId: string): void
  /** Drops what an agent has waiting, leaving the turn it is in alone. */
  clearQueue(agentId: string): void
  /**
   * Empties an agent's conversation, which is what `/clear` means everywhere
   * else and did not mean here. False while it is mid-turn.
   */
  /**
   * Moves a running agent to another model, without stopping it.
   *
   * The model is read at the top of every turn, so nothing has to restart —
   * and the leader cannot be restarted at all, which made it the one agent
   * that could not be moved to a better one.
   */
  setModel(agentId: string, to: { model?: string; provider?: string }): boolean
  forget(agentId: string): boolean
  /**
   * Lets an agent act without being asked, or stops letting it.
   *
   * For this session only, and never written to the config: trust given in the
   * middle of a task is trust given for that task, and a session that quietly
   * turned an agent loose for good is a session that surprises you tomorrow.
   * The hard guards are unaffected — what can never be written stays
   * unwritable, and a command that cannot be taken back is still asked about.
   */
  setYolo(agentId: string, on: boolean): boolean
  /**
   * Starts another agent of an existing role, in its own worktree.
   *
   * By role rather than from nothing: an agent is a system prompt and a set of
   * tools, and inventing those from a name typed in a hurry produces an agent
   * that does not know what it is for.
   */
  spawn(role: string, over?: { provider?: string; model?: string }): Promise<string>
  /**
   * Starts a second job, in a checkout of its own, with its own agents.
   *
   * The agents on it are named `<task>/<role>`, because two coders on two jobs
   * are two different things and a row of tabs has to say which is which.
   */
  startTask(name: string, roles: string[]): Promise<string[]>
  /**
   * Puts an agent on the running team.
   *
   * For one added while a session is up: writing its file and rereading the
   * project changes what the team editor shows and nothing else, so the agent
   * had no tab and could not be spoken to until the next start.
   */
  join(agent: AgentDef): Promise<void>
  /**
   * Stops an agent and takes it off the team.
   *
   * Says what became of its checkout: gone with it, or kept because the work
   * in it exists nowhere else — the two call for different sentences.
   */
  kill(agentId: string): Promise<{ workspace: 'removed' | 'kept' | 'none' }>
  /** What an agent has changed in its worktree, as a diff. */
  diff(agentId: string): Promise<string>
  /** Merges the branch of the job an agent is on into the repository. */
  merge(agentId: string): Promise<MergeOutcome>
  /** Resolves once nobody on the team has anything left to do. */
  idle(): Promise<void>
  /**
   * Work handed over that nobody is going to do, said in words, or nothing.
   *
   * Asked rather than announced, for the reason falling behind is: a stall is
   * the absence of things happening, and nothing fires to say nothing
   * happened. Whoever draws the screen asks on the beat it already has.
   */
  /**
   * How many handoffs are outstanding, whether or not anybody is working.
   *
   * `stalled` answers only when nothing is happening, which is the emergency.
   * This is the ordinary question — is anybody owed an answer — and it has one
   * while the team is busy too.
   */
  outstanding(): number
  stalled(): SessionNotice | undefined
  /**
   * Turns the team's shared note on or off, now rather than at the next start.
   *
   * A setting somebody is switching in order to see what it does has to do it
   * while they are looking.
   */
  setSharedMemory(on: boolean): void
  /**
   * What each job has cost so far, by task.
   *
   * Per task rather than per agent because that is the question people ask —
   * "what did this piece of work cost" — and because an agent can be killed
   * and take its own total with it while the job carries on.
   */
  spentByTask(): Map<string, Usage>
  shutdown(): Promise<void>
  prices: Prices
}

export type TeamOptions = {
  runtime: Runtime
  cwd: string
  env: Record<string, string | undefined>
  agents: AgentDef[]
  defaultProvider: string
  /** What the project says a model costs, for the services that will not say. */
  prices?: Record<string, { input: number; output: number }>
  /** Whether agents on a task keep a note the others can read. */
  sharedMemory?: boolean
  /** Where this project says how its team works, from `[sources] orchestration`. */
  orchestration?: string[]
  /** The agent every job reports back to, which cannot be taken off the team. */
  leader?: string
  /** Tool calls one turn may make, when the project says so. */
  toolCallsPerTurn?: number
  skills: Parameters<typeof createSkillsPlugin>[0]
  /** Called whenever anything changes, so the interface can redraw. */
  onChange(lines: Line[], snapshots: AgentSnapshot[]): void
  /**
   * Asks the user about a call that cannot be taken back. Absent means
   * headless, where there is nobody to ask and nothing is guarded.
   */
  onApproval?(request: ApprovalRequest): Promise<Decision>
  /**
   * Asks what to do when one agent sends work to another that is busy.
   * Absent means headless, where it simply queues.
   */
  onContention?(request: ContentionRequest): Promise<Contention>
}

/**
 * Starts a team and keeps the interface fed with what it does.
 *
 * Events are turned into lines here rather than in the screen, so the screen
 * never has to know what a `LoopEvent` is.
 */
export async function startTeam(options: TeamOptions): Promise<LiveTeam> {
  const { runtime, cwd, env, agents } = options

  // Read once when the session opens rather than per turn: it is a file
  // somebody wrote about how their team works, not a live setting, and a disk
  // read in the way of a keystroke is a disk read nobody asked for.
  const orchestration = await readOrchestration(options.orchestration ?? [])
  // Named by the project, or the first agent it declares. A team always has a
  // leader: the position is what gives a job somewhere to come back to, and
  // one that had to be configured before anything worked would be a setting
  // standing in front of the thing it configures.
  const leads = leaderOf(options.leader, agents)

  const credentials = resolveTeamCredentials(
    agents,
    options.defaultProvider,
    { env, store: runtime.store },
    (providerId) => runtime.host.registry.provider(providerId)?.needsKey !== false,
  )

  if (options.skills.length > 0) {
    runtime.host.registry.register(createSkillsPlugin(options.skills))
  }

  // Whatever this project said before, already on screen: a resumed session
  // that opens empty looks like the work was lost.
  const history = openJournal(cwd, runtime.home)
  // Anything an earlier version left in a database beside the project, brought
  // across once. The database is not deleted: losing a record while changing
  // how records are kept would be the worst possible moment for it.
  if (existsSync(join(cwd, HISTORY_FILE))) {
    const older = openHistory(cwd)
    importDatabase(history, older)
    older.close()
  }
  /**
   * Builds a provider for one agent, for the work that happens outside a turn.
   *
   * Nothing is cached: this is called when a conversation is shortened, which
   * is rare, and holding a second client per agent for it would be a cost paid
   * always for a thing that happens seldom.
   */
  const buildProvider = (agentId: string, providerId: string) => {
    const resolved = credentials.for(agentId)
    if (!resolved) return undefined
    try {
      return createProvider(runtime.host, providerId, {
        apiKey: resolved.apiKey,
        cwd,
        ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
        ...providerOptions(providerId, env, runtime.store),
      })
    } catch {
      // A provider that cannot be built is one summary that does not happen,
      // not a session that ends.
      return undefined
    }
  }

  const lines: Line[] = history
    .transcript()
    .map((line) => ({ agentId: line.agentId, kind: line.kind as Line['kind'], text: line.text }))
  let host: ReturnType<typeof createTeamHost>

  /**
   * Tells the screen what changed, and survives the screen not liking it.
   *
   * The interface is somebody else's code — a render that throws, a plugin
   * drawing into a slot, a listener added by a screen that has since gone.
   * This is called from timers, from stream events and from inside an agent's
   * turn, so an error escaping here would take down whatever was running: a
   * throw from a redraw once made starting a session fail outright.
   */
  const announce = (): void => {
    try {
      options.onChange([...lines], host.list())
    } catch (error) {
      // Reported, not swallowed. Nowhere to draw it — drawing is what just
      // failed — so it goes where a developer will find it.
      console.error('aidcrew: the interface threw while being told what changed:', error)
    }
  }

  /**
   * Who is on the team, kept from the events so `record` can ask without
   * reaching for `host` — which is not assigned until after the events from
   * spawning have already arrived.
   */
  const roster: string[] = []

  const record = (given: Line): void => {
    // Filed under an agent, always. A line filed under a task name, or under
    // an agent that is gone, is a line nothing draws: `/task other nosuchrole`
    // put its error under `other`, the pane said only "nothing started", and
    // the tray counted one unseen notice that could never be seen.
    const first = roster[0]
    const line =
      first !== undefined && !roster.includes(given.agentId) ? { ...given, agentId: first } : given
    // A note says something changed. Written again with nothing in between it
    // says nothing changed, and the transcript grows anyway — which is the one
    // cost a line carrying no news should not have. Turning three agents loose
    // wrote `unleashed` three times, and the tab already says it for as long
    // as it is true. Only immediate repeats: the same note after a different
    // one is a second event, and dropping that would hide it.
    const last = lines[lines.length - 1]
    if (
      line.kind === 'note' &&
      last?.kind === 'note' &&
      last.agentId === line.agentId &&
      last.text === line.text
    ) {
      return
    }

    lines.push(line)
    history.append(line)
    // Bounded: an interface only shows the tail, and an unbounded array in a
    // long session is a memory leak nobody notices until it matters.
    if (lines.length > 2000) lines.splice(0, lines.length - 2000)
    announce()
  }

  // Trust is per agent, and it is read from the project config rather than
  // from a switch here: it is a decision about this team, and it belongs where
  // the rest of that decision lives.
  const trusted = new Set(agents.filter((agent) => agent.yolo === true).map((agent) => agent.id))

  const approval = createApprovalPlugin({
    remembered: new Set(),
    enabled: options.onApproval !== undefined,
    trusted: (agentId) => trusted.has(agentId),
    ask: options.onApproval ?? (async () => 'no'),
  })

  // The guards that no amount of trust switches off: what can never be written
  // at all, what always has to be asked about, and a copy of everything before
  // it changes so any of it can be taken back.
  // Told to the host's guards rather than registered again: registering a
  // second set would mean two of everything, and the headless one refusing
  // what this one is about to ask about.
  runtime.session.trust = (agentId) => (trusted.has(agentId) ? 'yolo' : 'ask')
  const onApproval = options.onApproval
  if (onApproval) {
    runtime.session.ask = async (request) =>
      (await onApproval({
        agentId: request.agentId,
        tool: request.tool,
        input: undefined,
        summary: request.summary,
        because: request.because,
        // The hard guards ask about one act at a time — a command that cannot
        // be taken back — and there is no wider version of that to allow.
        scopes: { broad: request.summary },
      })) === 'once'

    // And a plugin's own question, on the same prompt. Against the first
    // agent, which is the pane somebody is looking at: the screen draws a
    // pending question in one agent's pane and nowhere else, so one filed
    // under a name that is not on the team is drawn by nothing, answered by
    // nobody, and left waiting forever by both. No tool is named because
    // none is about to run. Every answer but a refusal is a yes, because a
    // plugin asks one question at one moment and there is no wider version
    // of it to allow.
    runtime.session.askPlugin = async (question) =>
      (await onApproval({
        agentId: host.list()[0]?.id ?? 'main',
        // The plugin's name where a tool's would go: it is what is about to
        // act, and a prompt that names nobody is one nobody can answer.
        tool: question.plugin,
        input: undefined,
        summary: question.title,
        because: question.detail ?? `${question.plugin} is asking before it acts on your behalf`,
        // No wider version: a plugin asks one thing, once, at one moment.
        // Offering "always" put a second key on the prompt that did the same
        // as the first, one labelled "yes" beside one labelled "once".
        scopes: {},
      })) !== 'no'
  }

  // Shortening a conversation that no longer fits. Which model writes the
  // summary is a decision per agent: its own by default, and a cheaper one
  // when the project names it, because summarising is small mechanical work.
  const byId = new Map(agents.map((agent) => [agent.id, agent]))
  const providerOf = (id: string): string => byId.get(id)?.provider ?? options.defaultProvider

  // Taken out before it is put back. These two belong to the session rather
  // than to the program — both are built out of this team's agents and models
  // — and the registry is the host's, which outlives any one project. Opening
  // a second one registered the same names again and was refused with "two
  // directories hold a plugin of that name", which sent whoever read it
  // hunting a duplicate directory that does not exist.
  runtime.host.registry.forget('hooks-compact')
  runtime.host.registry.forget('hooks-approval')

  runtime.host.registry.register(
    createCompactPlugin({
      budgetFor: (agentId) => ({
        compactAt: byId.get(agentId)?.compactAt ?? DEFAULT_BUDGET.compactAt,
        keep: DEFAULT_BUDGET.keep,
      }),
      handlesItsOwn: (agentId) =>
        runtime.host.registry.provider(providerOf(agentId))?.keepsOwnHistory === true,
      // `compactWith` names a provider, and may name the model with it —
      // `zen/deepseek-v4-flash`. Handed to the provider whole, the name was
      // no provider at all, so no summariser was built and the expensive
      // model went on summarising itself.
      summariserFor: (agentId) => {
        const named = byId.get(agentId)?.compactWith
        return named ? buildProvider(agentId, parseCompactWith(named).provider) : undefined
      },
      summaryModelFor: (agentId) => {
        const named = byId.get(agentId)?.compactWith
        return named ? parseCompactWith(named).model : undefined
      },
      providerFor: (agentId) => buildProvider(agentId, providerOf(agentId)),
      onCompacted: (report) =>
        record({
          agentId: report.agentId,
          kind: 'note',
          text: `shortened ${report.summarised} earlier messages, kept ${report.kept}, summarised by ${report.by}${
            report.fellBackBecause ? ` (the cheaper one failed: ${report.fellBackBecause})` : ''
          }`,
        }),
    }),
  )

  runtime.host.registry.register(approval)

  /** Set once the allowance can be asked for; does nothing before that. */
  let askAgain: () => void = () => {}

  host = createTeamHost({
    cwd,
    // Read once when the session opens rather than per turn: it is a file
    // somebody wrote about how their team works, not a live setting, and
    // re-reading it every turn would put a disk read in the way of a keystroke.
    ...(orchestration ? { orchestration } : {}),
    ...(leads ? { leader: leads } : {}),
    ...(options.toolCallsPerTurn ? { maxTurnsPerInstruction: options.toolCallsPerTurn } : {}),
    // Every hook comes from the registry, including these two: there is no
    // privileged path into the loop, and an interface that forgot to register
    // one of them would simply run without it.
    hooks: hooksFor(runtime.host),
    hookNames: runtime.host.registry.installedHooks().map((one) => one.plugin),
    history,
    host: runtime.host,
    credentials,
    tools: runtime.host.registry.tools(),
    limits: DEFAULT_LIMITS,
    isolate: true,
    defaultProvider: options.defaultProvider,
    ...(options.sharedMemory
      ? {
          sharedMemory: true,
          // Summarised by whichever model the project would use to shorten a
          // conversation: it is the same small mechanical job, and letting an
          // expensive model do it is how a bill becomes hard to explain.
          summariseNotes: async (task: string, older: Note[]) => {
            const first = agents[0]?.id ?? ''
            const cheap = byId.get(first)?.compactWith
            const named = cheap === undefined ? undefined : parseCompactWith(cheap)
            const provider = buildProvider(first, named?.provider ?? providerOf(first))
            if (!provider) return ''

            const asked = older.map((note: Note) => `- ${note.from}: ${note.text}`).join('\n')
            let summary = ''
            try {
              for await (const delta of provider.send(
                {
                  model: named?.model ?? byId.get(first)?.model ?? 'default',
                  system:
                    'Summarise these notes from a team working on one task, in three sentences ' +
                    'at most. Keep decisions and constraints; drop anything already obvious ' +
                    'from the code.',
                  messages: [{ role: 'user', content: [{ type: 'text', text: asked }] }],
                  tools: [],
                  maxTokens: 400,
                },
                new AbortController().signal,
              )) {
                if (delta.type === 'text_delta') summary += delta.text
              }
            } catch {
              // A summariser that failed leaves the notes counted rather than
              // summarised, which the caller already handles.
              return ''
            }
            record({ agentId: task, kind: 'note', text: `shortened the team's notes on ${task}` })
            return summary
          },
        }
      : {}),
    ...(options.onContention ? { onContention: options.onContention } : {}),
    providerOptions: (id) => providerOptions(id, env, runtime.store),
    onEvent: (event) => {
      // A turn ending is when a plan moves; the two-minute timer is the
      // backstop for a session where nothing is happening.
      if (event.type === 'agent_status' && event.status === 'idle') askAgain()
      if (event.type === 'agent_spawned') roster.push(event.id)
      if (event.type === 'agent_killed')
        roster.splice(0, roster.length, ...roster.filter((id) => id !== event.id))
      const produced = toLines(event)
      // Events with nothing to show still change the roster, so the interface
      // is told either way.
      if (produced.length > 0) for (const line of produced) record(line)
      else announce()
    },
  })

  // Only the ones that can actually talk. A provider is built on an agent's
  // first turn rather than when it starts, so an agent with no key used to
  // join the tab bar looking ready and fail the moment it was picked. Said
  // once, here, rather than discovered later by whoever picked it.
  for (const agent of agents) {
    if (credentials.for(agent.id)) {
      await host.spawn(agent)
      continue
    }
    record({
      agentId: agent.id,
      kind: 'error',
      text: `${agent.id} has no key for "${agent.provider ?? options.defaultProvider}", so it is not on the team. Add one in settings.`,
    })
  }
  // What was said before, not an empty screen: this used to send `[]` and
  // throw away the transcript that had just been read back off the disk, so a
  // resumed session looked exactly like a lost one.
  // Plugins reloaded when they change on disk, which is what the README has
  // promised from the first day: no build step, no publishing, no restart.
  // The tools an agent has are worked out at the start of every turn, so an
  // edit lands on the next one — the way a setting does.
  const watching = watchDirectories(
    pluginDirectoriesFor({ cwd, home: runtime.home }).map((source) =>
      typeof source === 'string' ? source : source.path,
    ),
    () => {
      void (async () => {
        const before = new Set(runtime.host.registry.tools().map((tool) => tool.name))
        const { failures } = await reloadPlugins(runtime.host, {
          cwd,
          home: runtime.home,
          allowPlugin: trustedPlugins(runtime.store, cwd),
          setup: runtime.setup,
        })

        host.setTools(runtime.host.registry.tools())
        host.setHooks(hooksFor(runtime.host))

        const after = runtime.host.registry.tools().map((tool) => tool.name)
        const added = after.filter((name) => !before.has(name))
        const gone = [...before].filter((name) => !after.includes(name))
        const who = host.list()[0]?.id ?? 'main'

        if (added.length > 0 || gone.length > 0) {
          record({
            agentId: who,
            kind: 'note',
            text: `plugins reloaded${added.length > 0 ? `, added ${added.join(', ')}` : ''}${
              gone.length > 0 ? `, dropped ${gone.join(', ')}` : ''
            } — the agents have them from their next turn`,
          })
        }
        for (const line of loadFailures(runtime, who)) record(line)
        void failures
      })().catch((error: unknown) => {
        record({
          agentId: host.list()[0]?.id ?? 'main',
          kind: 'error',
          text: `reloading plugins failed: ${error instanceof Error ? error.message : String(error)}`,
        })
      })
    },
  )

  // From here on a plugin's news has somewhere to go the moment it is said,
  // rather than onto the pile `openRuntime` keeps for the time before this.
  // Against the first agent, for the reason the load failures are.
  runtime.session.note = (text) =>
    record({ agentId: host.list()[0]?.id ?? 'main', kind: 'note', text })

  // Said before anything else, because it explains a tool that is missing or
  // a hook that never runs — the two things somebody would otherwise spend an
  // afternoon on.
  // Against the first agent, which is the pane somebody is looking at: a line
  // filed under a name that is not on the team is a line nothing ever draws.
  for (const line of loadFailures(runtime, host.list()[0]?.id ?? 'main')) record(line)

  announce()

  // Fetched once, in the background: a price list is a convenience, and
  // waiting on one before the first agent can speak would make it a cost.
  const stated = options.prices ?? {}
  const table: PriceTable = { ...fromConfig(stated, 'the project') }
  void (async () => {
    for (const source of runtime.host.registry.prices()) {
      for (const providerId of new Set(
        agents.map((agent) => agent.provider ?? options.defaultProvider),
      )) {
        if (!source.covers(providerId)) continue
        const resolved = credentials.for(agents[0]?.id ?? '')
        const definition = runtime.host.registry.provider(providerId)
        const loaded = await source.load(providerId, {
          baseUrl: definition?.endpoint,
          apiKey: resolved?.apiKey,
        })
        // What the project says wins: it is the one figure somebody checked.
        for (const [model, price] of Object.entries(loaded)) {
          if (!stated[model]) table[model] = price
        }
      }
    }
  })().catch((error: unknown) => {
    // A price is a convenience. The registry already contains each source so
    // one cannot take the others down, and this catches whatever is left —
    // an endpoint lookup, a credential — rather than letting it out as an
    // unhandled rejection into a terminal drawing a interface.
    console.error('aidcrew: loading prices failed:', error)
  })

  /**
   * What a model costs, in the order the answers are worth having.
   *
   * The project first, because that is the one figure somebody checked; then
   * whatever the service published about itself; then the bundled list, which
   * is a guess and says so. Zen bills every token and publishes no prices at
   * all, so without the third the screen showed nothing for a service that
   * costs money.
   */
  const priceFor = (model: string) => priceOf(table, model) ?? bundledPriceOf(model)

  const costFor = (agentId: string): number | undefined => {
    const agent = host.list().find((one) => one.id === agentId)
    if (!agent) return undefined
    return costOf(agent.usage, priceFor(agent.model))
  }

  /** Whether what is shown for an agent is a list price rather than a bill. */
  const estimatedFor = (agentId: string): boolean => {
    const agent = host.list().find((one) => one.id === agentId)
    return agent !== undefined && isEstimate(agent.usage, priceFor(agent.model))
  }

  // What is left of the plan, asked once and refreshed as the session runs:
  // it is the number that ruins an afternoon when nobody looked.
  // Kept per service, because a plan belongs to a credential and a team can
  // hold several. Asked for the team and answered by whichever provider
  // replied first, this drew one figure over a session where two were true
  // and never said which of the two it was — and it asked every service with
  // the first agent's key, so the answer could be the wrong account's.
  const remaining = new Map<string, string>()
  const providerOfAgent = (agentId: string): string =>
    agents.find((one) => one.id === agentId)?.provider ?? options.defaultProvider

  /** What each service last said was left, so a crossing can be noticed. */
  const allowances = new Map<string, Allowance>()
  // Every turn end asks, and a team of five ending turns together would ask
  // five times in one second for one answer.
  const gate = refreshGate(20_000)

  const askAllowance = async (): Promise<void> => {
    // One agent per service, so each is asked with a key that belongs to it.
    const asking = new Map<string, string>()
    for (const one of agents) {
      const providerId = one.provider ?? options.defaultProvider
      if (!asking.has(providerId)) asking.set(providerId, one.id)
    }

    gate.passed(Date.now())
    let changed = false
    for (const [providerId, agentId] of asking) {
      const definition = runtime.host.registry.provider(providerId)
      const resolved = credentials.for(agentId)
      const found = await loadAllowance(providerId, {
        baseUrl: definition?.endpoint,
        apiKey: resolved?.apiKey,
      })
      if (!found || found.windows.length === 0) continue

      // What changed, said once. The tray shows the figure for as long as it
      // is true, which is right for a figure and wrong for news: an afternoon
      // can end on a plan nobody saw running down.
      for (const said of crossings(allowances.get(providerId), found)) {
        record({ agentId: host.list()[0]?.id ?? 'main', kind: 'note', text: said })
      }
      allowances.set(providerId, found)

      const next = allLeft(found)
      if (next !== remaining.get(providerId)) {
        remaining.set(providerId, next)
        changed = true
      }
    }

    // Asked again every couple of minutes, and the screen has to be told:
    // updating the value without a redraw left the same figure on screen for
    // the whole session, which reads as a number that never moves.
    if (changed) announce()
  }

  // Asked again when a turn ends, since that is when a plan actually moves.
  // Assigned rather than declared here: the events that call it are wired up
  // several hundred lines above, while the agents are still starting, and a
  // const declared after that point does not exist yet when they fire.
  askAgain = () => {
    if (gate.wait(Date.now()) > 0) return
    void askAllowance()
  }
  void askAllowance()
  const refresh = setInterval(() => void askAllowance(), 120_000)

  // How far each agent has fallen behind, checked every few seconds. It grows
  // while they do nothing: every commit you make in your own editor leaves
  // every idle agent one further back, and an agent that looks idle and
  // current is the one that answers confidently about code that has changed.
  const sweep = setInterval(() => {
    // Caught here as well as inside announce: the sweep itself runs git, and
    // a repository that has moved under it should cost one skipped check
    // rather than an unhandled rejection printed over the screen.
    void host
      .sweep()
      .then(announce)
      .catch((error: unknown) =>
        console.error('aidcrew: checking how far agents have fallen behind failed:', error),
      )
  }, 5_000)
  void host.sweep().catch(() => {})

  return {
    prices: {
      allowance: (agentId: string) => remaining.get(providerOfAgent(agentId)),
      costOf: costFor,
      // A figure from a list in this repository is a guess about a bill, and
      // a guess drawn in the same type as a fact gets believed like one.
      estimated: estimatedFor,
      // Nothing rather than a subtotal when any agent cannot be priced: a
      // session that cannot be costed and one that cost nothing are different
      // facts, and so are a session that cost this much and one that cost at
      // least this much.
      total: () => totalOf(host.list().map((agent) => costFor(agent.id))),
      // What a card was charged and what came off a plan, apart. One team on
      // a subscription and an API key at once is the thing this is for, and a
      // single figure answers neither question it raises.
      split: () => splitOf(host.list().map((agent) => agent.usage)),
    },
    snapshots: () => host.list(),
    /** Handed over and not answered, however long ago and whoever is busy. */
    outstanding: () => host.outstanding().length,
    stalled: () => {
      const waiting = host.stalled()
      if (!waiting || waiting.length === 0) return undefined
      return stallNotice(waiting, host.list())
    },
    cancel: (agentId) => {
      if (!host.cancel(agentId)) return
      record({ agentId, kind: 'note', text: 'stopped' })
    },
    clearQueue: (agentId) => {
      const dropped = host.clearQueue(agentId)
      // Said either way. Silence when there was nothing queued is
      // indistinguishable from a command that does not work, which is what it
      // was taken for.
      record({
        agentId,
        kind: 'note',
        text:
          dropped > 0
            ? `dropped ${dropped} instruction${dropped === 1 ? '' : 's'} that were waiting`
            : 'nothing was waiting to be dropped',
      })
    },
    setModel: (agentId, to) => {
      // A new service means a new key. The keys were resolved for the team as
      // it stood, by agent, so an agent moved to another service kept the
      // key it had and failed on its next turn with somebody else's error.
      if (to.provider !== undefined && to.provider !== providerOf(agentId)) {
        const template = byId.get(agentId) ?? { id: agentId, description: '', systemPrompt: '' }
        if (!credentials.admit({ ...template, provider: to.provider })) {
          throw new Error(`${agentId} has no key for "${to.provider}". Add one in settings.`)
        }
      }
      return host.setModel(agentId, to)
    },
    forget: (agentId) => {
      if (!host.forget(agentId)) return false

      // The screen goes with it. This threw away the model's conversation,
      // left every line of it in front of you and then added one more saying
      // it had started again — so the visible result of the word was that the
      // transcript got longer, which is the opposite of what it means
      // everywhere else it is typed.
      //
      // Three places hold those lines and all three have to let go: the array
      // being drawn, the file it is read back from tomorrow, and the model's
      // own history, which `host.forget` has already taken.
      history.forget(agentId)
      for (let at = lines.length - 1; at >= 0; at--) {
        if (lines[at]?.agentId === agentId) lines.splice(at, 1)
      }

      // One line rather than none. An emptied pane with nothing in it reads as
      // a session that lost your work, and the difference between cleared and
      // broken is worth a sentence.
      record({
        agentId,
        kind: 'note',
        text: 'this conversation starts again from here. What it has spent stays on the bill.',
      })
      return true
    },
    spawn: async (role, over) => {
      const template = agents.find((agent) => (agent.role ?? agent.id) === role)
      if (!template) {
        const known = [...new Set(agents.map((agent) => agent.role ?? agent.id))]
        throw new Error(`no role called "${role}". This project has: ${known.join(', ')}`)
      }

      // Named after the role, numbered upward, so who a second is a second of
      // is readable at a glance in a row of tabs.
      let at = 2
      const taken = new Set(host.list().map((agent) => agent.id))
      while (taken.has(`${role}-${at}`)) at += 1
      const id = taken.has(role) ? `${role}-${at}` : role

      const snapshot = await host.spawn({
        ...template,
        id,
        role,
        ...(over?.provider ? { provider: over.provider } : {}),
        ...(over?.model ? { model: over.model } : {}),
      })
      record({ agentId: id, kind: 'note', text: `started, on ${snapshot.model}` })
      return id
    },

    startTask: async (name, roles) => {
      const wanted =
        roles.length > 0 ? roles : [...new Set(agents.map((agent) => agent.role ?? agent.id))]

      const started: string[] = []
      for (const role of wanted) {
        const template = agents.find((agent) => (agent.role ?? agent.id) === role)
        if (!template) {
          record({ agentId: name, kind: 'error', text: `no role called "${role}"` })
          continue
        }

        const id = `${name}/${role}`
        if (host.list().some((agent) => agent.id === id)) continue

        // Its key, before it starts: an agent that spawns and cannot speak
        // is worse than one that does not spawn, and this one used to.
        if (!credentials.for(id) && !credentials.admit({ ...template, id })) {
          record({
            agentId: name,
            kind: 'error',
            text: `${id} has no key for "${template.provider ?? options.defaultProvider}", so it did not start.`,
          })
          continue
        }
        await host.spawn({ ...template, id, role, task: name })
        started.push(id)
      }

      if (started.length > 0) {
        record({
          agentId: started[0] as string,
          kind: 'note',
          text: `task "${name}" started, in a checkout of its own — ${started.join(', ')}`,
        })
      }
      return started
    },

    join: async (agent) => {
      if (host.list().some((running) => running.id === agent.id)) return

      // Keys were resolved for the team as it stood when this started, so a
      // newcomer has none. Spawning is lazy about providers, so without this
      // the agent joined happily and then could not say a word: it sat in the
      // list with nothing behind it, which is worse than not joining at all.
      const providerId = agent.provider ?? options.defaultProvider
      if (!credentials.for(agent.id) && !credentials.admit(agent)) {
        throw new Error(`${agent.id} has no key for "${providerId}". Add one in settings.`)
      }

      const snapshot = await host.spawn(agent)
      record({ agentId: agent.id, kind: 'note', text: `joined the team, on ${snapshot.model}` })
      announce()
    },

    kill: async (agentId) => {
      const outcome = await host.kill(agentId)
      announce()
      return outcome
    },

    diff: async (agentId) => await host.diff(agentId),
    merge: async (agentId) => await host.merge(agentId),

    idle: () => host.idle(),

    setSharedMemory: (on) => {
      host.setSharedMemory(on)
      record({
        agentId: host.list()[0]?.id ?? 'main',
        kind: 'note',
        text: on
          ? 'the team keeps a shared note now — agents can write to it with task_note'
          : 'the team has stopped keeping a shared note',
      })
    },

    spentByTask: () => {
      const totals = new Map<string, Usage>()
      for (const agent of host.list()) {
        // The same addition an agent's own turns go through, rather than a
        // second one written out here. Written out, it rebuilt the running
        // total field by field with a conditional spread, so a later agent
        // with no cached reads left the key off the object being built and
        // destroyed the total's own — order-dependent, flattering, and then
        // written to disk two lines below.
        const running = totals.get(agent.task) ?? { inputTokens: 0, outputTokens: 0 }
        totals.set(agent.task, addUsage(running, agent.usage))
      }
      // Written down as it is worked out: the totals of agents still running
      // are the live half, and the file holds what earlier sessions spent.
      for (const [task, usage] of totals) history.rememberTask(task, usage)
      return totals
    },

    setYolo: (agentId, on) => {
      if (!host.setYolo(agentId, on)) return false
      if (on) trusted.add(agentId)
      else trusted.delete(agentId)
      // One word. The sentence explaining what unleashing means was written
      // once per agent, and a team of five turning loose read as five pieces
      // of news that were all the same sentence. The tab already says
      // `unleashed` for as long as it is true, which is where a state belongs
      // — the transcript only has to say that it changed.
      record({ agentId, kind: 'note', text: on ? 'unleashed' : 'asking again' })
      return true
    },

    tell: async (agentId, text) => {
      // Recorded before it is delivered: what you asked is half the
      // conversation, and without it the transcript was every answer and
      // nothing any of them was answering.
      record({ agentId, kind: 'ask', text })
      await host.tell(agentId, text)
      announce()
    },
    shutdown: async () => {
      clearInterval(refresh)
      clearInterval(sweep)
      watching.close()
      await host.shutdown()
      history.close()
    },
  }
}

/**
 * One team event as one line, or nothing when there is nothing to show.
 *
 * The assistant's own words come from `assistant_turn` rather than from the
 * deltas: a turn arrives complete, so a sentence is added once instead of
 * being rewritten character by character — and reasoning stays separable,
 * which is what lets ^r hide it.
 */
/**
 * The opening of a handoff, for the pane of the agent that sent it.
 *
 * The sender does not need to read back the instruction it just wrote; it
 * needs to see that it sent one, and to whom. The receiver gets the whole
 * thing, because the receiver has to act on it.
 */
/**
 * Why a turn stopped instead of finishing, in words worth reading.
 *
 * The tool is the part somebody can act on: "it ran out of room" is a shrug,
 * and "the write it had started never ran" says what was lost. `max_turns`
 * borrows the sentence the headless path has printed since the beginning —
 * there is no reason for the team to invent a second wording for it.
 */
function cutShortly(reason: string, tool?: string): string {
  // What the pane above already says, in one clause: the notice's job is to
  // point at it, not to explain it a second time and differently.
  if (reason === 'failed') return 'failed — the reason is in its pane'
  if (reason === 'max_turns')
    return 'stopped at its bound of tool calls without finishing — what it wrote is in its checkout'
  if (reason === 'refusal') return 'the model refused to carry on'
  const what = tool ? `the ${tool} it had started never ran` : 'it stopped mid-sentence'
  return `ran out of room before it finished — ${what}`
}

function firstLine(text: string): string {
  const line = text.split('\n').find((one) => one.trim() !== '') ?? ''
  return line.length > 90 ? `${line.slice(0, 90)}…` : line
}

export function toLines(event: TeamEvent): Line[] {
  switch (event.type) {
    case 'agent_message':
      // Written into both panes, from each side's point of view. Shown only to
      // the receiver, a handoff was invisible unless you happened to be
      // looking at the agent it woke — so an agent could start spending on
      // work you never asked it for, and the first you knew was the bill.
      return [
        { agentId: event.from, kind: 'note', text: `→ ${event.to}: ${firstLine(event.text)}` },
        { agentId: event.to, kind: 'note', text: `← ${event.from}: ${event.text}` },
      ]

    case 'agent_refreshed':
      // Said out loud, because it changes what the agent is looking at: one
      // that has been standing a while answers about code that has since
      // moved, and this is why its next answer may contradict its last.
      return [
        {
          agentId: event.id,
          kind: 'note',
          text: `caught up with the repository, ${event.commits} commit${
            event.commits === 1 ? '' : 's'
          } newer`,
        },
      ]

    case 'agent_blocked':
    case 'agent_failed':
      return [{ agentId: event.id, kind: 'error', text: event.reason }]

    case 'workspace_resumed': {
      // Said before the agent says anything, so its first report is read as
      // a report on files it found rather than files it wrote.
      const changed =
        event.changed === 0
          ? 'commits on no branch'
          : `${event.changed} file${event.changed === 1 ? '' : 's'} changed and not committed`
      return [
        {
          agentId: event.id,
          kind: 'note',
          text: `picked up the checkout for ${event.task} where the last session left it: ${changed}`,
        },
      ]
    }

    case 'workspace_kept':
      // Filed under the task: the agent that was in it has just gone.
      return [
        {
          agentId: event.task,
          kind: 'note',
          text: `kept the checkout for ${event.task}, at ${event.path}: the work in it is nowhere else, and the next session picks it up`,
        },
      ]

    case 'agent_cut_short':
      return [{ agentId: event.id, kind: 'error', text: cutShortly(event.reason, event.tool) }]

    case 'agent_continued':
      return [
        {
          agentId: event.id,
          kind: 'note',
          text: `reached its turn limit with the work unfinished — sent back to carry on (${event.round} of ${event.of})`,
        },
      ]

    case 'agent_event': {
      const inner = event.event

      if (inner.type === 'tool_start') {
        return [
          { agentId: event.id, kind: 'tool', text: `${inner.name} ${summarise(inner.input)}` },
        ]
      }
      if (inner.type === 'tool_end' && inner.output.isError) {
        return [{ agentId: event.id, kind: 'error', text: inner.output.content.slice(0, 200) }]
      }

      // What the agent actually said — the thing the whole interface exists
      // to show, and which nothing was emitting.
      if (inner.type === 'assistant_turn') {
        return inner.turn.content.flatMap((block): Line[] => {
          if (block.type === 'text' && block.text.trim() !== '') {
            return [{ agentId: event.id, kind: 'say', text: block.text.trim() }]
          }
          if (block.type === 'thinking' && block.text.trim() !== '') {
            return [{ agentId: event.id, kind: 'thinking', text: block.text.trim() }]
          }
          // A tool call an agent made and ran itself — another coding program
          // on the team, reporting what it did with tools of its own. Left
          // out, its pane showed conclusions and never the work.
          //
          // Only when the turn has already finished. `tool_use` as the stop
          // reason means our own loop is about to run these and will report
          // each one as `tool_start`, so listing them here as well wrote every
          // ordinary agent's calls down twice.
          if (block.type === 'tool_use' && inner.turn.stopReason !== 'tool_use') {
            return [
              { agentId: event.id, kind: 'tool', text: `${block.name} ${summarise(block.input)}` },
            ]
          }
          return []
        })
      }

      return []
    }

    default:
      return []
  }
}

function summarise(input: unknown): string {
  if (typeof input !== 'object' || input === null) return ''
  const first = Object.values(input).find((value) => typeof value === 'string')
  return typeof first === 'string' && first.length > 40 ? `${first.slice(0, 40)}…` : (first ?? '')
}

/**
 * A stopped team, in the words somebody can act on.
 *
 * "Nothing is happening" is what the user could already see. What makes this
 * worth drawing over their screen is who was waiting on whom, how long, how
 * that agent's turn ended, and what it last said — because a turn that ran out
 * of room and one that answered and went quiet are different problems with
 * different fixes.
 */
export function stallNotice(
  waiting: Handoff[],
  agents: AgentSnapshot[],
  now = Date.now(),
): SessionNotice {
  const [first, ...rest] = waiting
  if (!first) throw new Error('a stall notice needs something outstanding')

  const said = agents.find((agent) => agent.id === first.to)?.lastText
  const detail = [
    `${first.from} → ${first.to}, ${since(first.at, now)}`,
    firstLine(first.text),
    first.cutShort
      ? `${first.to}'s turn ${cutShortly(first.cutShort)}`
      : `${first.to} never took a turn on it.`,
    ...(said ? [`It last said: "${firstLine(said)}"`] : []),
    ...(rest.length > 0 ? [`and ${rest.length} more.`] : []),
  ]

  return {
    title: `nobody is working, and ${waiting.length === 1 ? 'one handoff has' : `${waiting.length} handoffs have`} no answer`,
    detail,
    // What ends this, not what hides it: it is drawn only while nothing is
    // happening, and telling anybody anything is what makes something happen.
    keys: [['↵', `tell ${first.to} to carry on`]],
    tone: 'ask',
    to: first.to,
  }
}

/** How long ago, in the roughness somebody reads at a glance. */
function since(at: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - at) / 1000))
  if (seconds < 90) return `${seconds} seconds ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 90) return `${minutes} minutes ago`
  return `${Math.round(minutes / 60)} hours ago`
}
