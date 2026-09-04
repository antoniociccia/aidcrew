import { join, resolve } from 'node:path'
import type {
  AgentDef,
  AgentSnapshot,
  Contention,
  ContentionRequest,
  Hooks,
  Limits,
  Message,
  Provider,
  TeamEvent,
  Tool,
  Usage,
} from '@aidcrew/core'
import { InProcessHost, tokensOf } from '@aidcrew/core'
import type { TeamCredentials } from './credentials.ts'
import type { History } from './history.ts'
import type { Host } from './host.ts'
import { createProvider } from './host.ts'
import type { AgentOverride } from './workspace.ts'

/**
 * Merges what the agent files say with what the project config overrides.
 *
 * The file carries the system prompt — the agent's actual definition — while
 * the config carries provider, model and tools, which are deployment choices
 * that differ per project and per person. An override naming an agent that has
 * no file is reported: it is almost always a typo, and silently ignoring it
 * means the agent runs on the wrong model without anyone noticing.
 */
export function resolveTeam(
  defined: AgentDef[],
  overrides: Record<string, AgentOverride>,
  defaults: { provider?: string; model?: string },
  /**
   * Whether an agent belongs to this project rather than to the user's home
   * directory. Agents from home join only when the config names them: someone
   * else's helpers should not turn up on every project's payroll.
   */
  belongsToProject: (agentId: string) => boolean = () => true,
): { team: AgentDef[]; unknown: string[] } {
  const byId = new Map(defined.map((agent) => [agent.id, agent]))
  const configured = Object.keys(overrides)

  // Configuring an agent says what model it runs on, not who else is on the
  // team: reading it as a roster made the other agents vanish for no reason a
  // person could see. Configured ones simply come first.
  const ordered = [
    ...configured
      .map((id) => byId.get(id))
      .filter((agent): agent is AgentDef => agent !== undefined),
    ...defined.filter((agent) => !overrides[agent.id] && belongsToProject(agent.id)),
  ]

  const team = ordered.map((agent) => {
    const override = overrides[agent.id] ?? {}
    const provider = override.provider ?? agent.provider ?? defaults.provider
    const model = override.model ?? agent.model ?? defaults.model
    const tools = override.tools ?? agent.tools
    const apiKeyEnv = override.apiKeyEnv ?? agent.apiKeyEnv
    const yolo = override.yolo ?? agent.yolo
    const compactAt = override.compactAt ?? agent.compactAt
    const maxTokens = override.maxTokens ?? agent.maxTokens
    const compactWith = override.compactWith ?? agent.compactWith
    const role = override.role ?? agent.role

    return {
      ...agent,
      ...(provider ? { provider } : {}),
      ...(model ? { model } : {}),
      ...(tools ? { tools } : {}),
      ...(apiKeyEnv ? { apiKeyEnv } : {}),
      ...(yolo ? { yolo } : {}),
      ...(compactAt ? { compactAt } : {}),
      ...(maxTokens ? { maxTokens } : {}),
      ...(compactWith ? { compactWith } : {}),
      ...(role ? { role } : {}),
    }
  })

  return {
    team,
    unknown: configured.filter((id) => !byId.has(id)),
  }
}

export type TeamOptions = {
  cwd: string
  host: Host
  /** Every agent's key, resolved before anything started. */
  credentials: TeamCredentials
  tools: Tool[]
  limits: Limits
  isolate: boolean
  onEvent(event: TeamEvent): void
  defaultProvider: string
  /** Non-credential options for one provider, such as prompted tool calling. */
  providerOptions(providerId: string): Record<string, unknown>
  /** Hooks wrapped around every tool call — approval lives here. */
  hooks?: Hooks[]
  /** Which plugin each set came from, so a hook that throws names somebody. */
  hookNames?: string[]
  /** Where an agent's conversation is kept, so a session can be resumed. */
  history?: History
  /** Asked when work is sent to an agent that is already busy. */
  onContention?(request: ContentionRequest): Promise<Contention>
  /** What ORCHESTRATE.md says about how this project's team works. */
  orchestration?: string
  /** The agent every job reports back to, which cannot be taken off the team. */
  leader?: string
  /** Tool calls one turn may make, when the project says so. */
  maxTurnsPerInstruction?: number
}

/**
 * Builds the runtime host for a team.
 *
 * Each agent's provider is built with its own credentials, which is what lets
 * a planner run on one service, or one plan, while a reviewer runs on another.
 */
export function createTeamHost(options: TeamOptions): InProcessHost {
  const providers = new Map<string, Provider>()

  return new InProcessHost({
    cwd: options.cwd,
    tools: options.tools,
    limits: options.limits,
    isolate: options.isolate,
    onEvent: options.onEvent,
    ...(options.onContention ? { onContention: options.onContention } : {}),
    ...(options.orchestration ? { orchestration: options.orchestration } : {}),
    ...(options.leader ? { leader: options.leader } : {}),
    ...(options.maxTurnsPerInstruction
      ? { maxTurnsPerInstruction: options.maxTurnsPerInstruction }
      : {}),
    ...(options.hooks ? { hooks: options.hooks } : {}),
    ...(options.hookNames ? { hookNames: options.hookNames } : {}),
    ...(options.history
      ? {
          historyFor: (agentId: string) => options.history?.messages(agentId) ?? [],
          usageFor: (agentId: string) => options.history?.usageOf(agentId),
          onHistory: (agentId: string, messages: Message[], usage: Usage) =>
            options.history?.remember(agentId, messages, usage),
        }
      : {}),
    providerFor: (agent, cwd) => {
      const id = agent.provider ?? options.defaultProvider
      const resolved = options.credentials.for(agent.id)
      if (!resolved) throw new MissingCredentialError([{ agentId: agent.id, providerId: id }])

      // Keyed by service, credential *and* directory: two agents on the same
      // provider but on different plans need two clients, and one that runs a
      // program needs one per worktree.
      const cacheKey = `${id}::${resolved.source}::${cwd}`
      const existing = providers.get(cacheKey)
      if (existing) return existing

      const provider = createProvider(options.host, id, {
        apiKey: resolved.apiKey,
        cwd,
        ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
        ...options.providerOptions(id),
      })
      providers.set(cacheKey, provider)
      return provider
    },
  })
}

export class MissingCredentialError extends Error {
  override readonly name = 'MissingCredentialError'

  constructor(readonly missing: { agentId: string; providerId: string }[]) {
    const listed = missing
      .map(({ agentId, providerId }) => `  ${agentId} needs a key for "${providerId}"`)
      .join('\n')
    super(`some agents have no key:\n${listed}\n\nAdd them in Settings.`)
  }
}

/** One line per agent, for the end of a run. */
export function summarise(agents: AgentSnapshot[]): string {
  if (agents.length === 0) return 'no agents ran'

  return agents
    .map((agent) => {
      const tokens = tokensOf(agent.usage)
      const isolation = agent.isolated ? '' : ' (shared workspace)'
      return `  ${agent.id.padEnd(12)} ${agent.model.padEnd(20)} ${agent.turns} turns, ${tokens} tokens${isolation}`
    })
    .join('\n')
}

/**
 * What this project says about how its team should work.
 *
 * Beside the agent files rather than inside one: how a team hands work around
 * is a property of the team, and writing it into every agent's file is how
 * five files come to disagree.
 *
 * The paths come from `[sources] orchestration` and are read in order, first
 * one that exists winning — the project's own before anything in a home
 * directory, because a file in a home directory is a preference about how you
 * like teams to work and the one in the repository is how this team works.
 *
 * Absent is the normal case and not a failure: the built-in wording is what
 * makes a team work for somebody who has never heard of this file. What a file
 * replaces is that wording, never the roster — who is actually running is the
 * half a file on disk cannot know, so the harness always supplies it.
 *
 * Unreadable is treated as absent. A team that will not start because a
 * markdown file has the wrong permissions is worse than a team using the
 * default.
 */
export async function readOrchestration(paths: string[]): Promise<string | undefined> {
  for (const path of paths) {
    try {
      const said = forAgents(await Bun.file(path).text())
      if (said !== '') return said
    } catch {
      // The next one, or the built-in wording.
    }
  }
  return undefined
}

/**
 * The half of the file the agents are sent.
 *
 * Everything above the first `---` on a line of its own is a note to whoever
 * edits the file, and is dropped. Without this, a file that explains itself —
 * which is the file anybody would actually write — pays for that explanation
 * on every request of every turn of every agent, and hands a model a
 * paragraph about a file it cannot see.
 *
 * No separator means the whole file, so the simplest possible one still works.
 */
function forAgents(text: string): string {
  const lines = text.split('\n')
  const at = lines.findIndex((line) => line.trim() === '---')
  return (at === -1 ? text : lines.slice(at + 1).join('\n')).trim()
}

/**
 * Which agent leads a team.
 *
 * The project's choice when it made one, and otherwise the first agent it
 * declares. A team always has a leader — that is what makes the position
 * useful — so this answers rather than asking, and a name that matches nobody
 * falls back rather than leaving the team with a leader that is not there.
 */
export function leaderOf(named: string | undefined, team: AgentDef[]): string | undefined {
  if (named !== undefined && team.some((agent) => agent.id === named)) return named
  return team[0]?.id
}

/**
 * Whether an agent found somewhere is on this project's team.
 *
 * Being found and being hired are different things. `~/.claude/agents` is
 * another tool's directory and can hold anything, so an agent there joins only
 * when the project names it: someone else's helpers should not turn up on
 * every project's payroll.
 *
 * `~/.aidcrew/agents` is not that. It is this tool's own home, and a team
 * written there is a team somebody meant to use again. Treating the two alike
 * is why starting a project meant inventing a crew from nothing while the one
 * you wanted sat unread on the same disk.
 *
 * An agent whose origin is unknown is kept, because the alternative is a team
 * that quietly loses members when the bookkeeping is incomplete.
 */
export function hired(from: string | undefined, cwd: string, home: string): boolean {
  if (from === undefined) return true
  return from.startsWith(resolve(cwd)) || from.startsWith(join(resolve(home), '.aidcrew'))
}
