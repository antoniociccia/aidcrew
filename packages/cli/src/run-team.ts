import { homedir } from 'node:os'
import type { AgentDef, AgentSnapshot, TeamEvent } from '@aidcrew/core'
import { DEFAULT_LIMITS } from '@aidcrew/core'
import { bundledPriceOf, fromConfig, priceOf } from '@aidcrew/prices'
import type { CliArgs } from './args.ts'
import type { Config } from './config.ts'
import { providerOptions } from './config.ts'
import { resolveTeamCredentials } from './credentials.ts'
import type { Host } from './host.ts'
import { jobCostSaid } from './job-cost.ts'
import { exitCodeOf, outcomeOf, summaryOf } from './outcome.ts'
import { createTeamRenderer } from './render.ts'
import type { SettingsStore } from './store.ts'
import {
  createTeamHost,
  hired,
  leaderOf,
  MissingCredentialError,
  readOrchestration,
  resolveTeam,
  summarise,
} from './team.ts'
import type { WorkspaceConfig } from './workspace.ts'

export { MissingCredentialError } from './team.ts'

export class NoTeamError extends Error {
  override readonly name = 'NoTeamError'

  constructor(searched: string[]) {
    super(
      `no agents found. Looked in:\n  ${searched.join('\n  ')}\n` +
        'An agent is a markdown file with name and description in its frontmatter.',
    )
  }
}

type TeamSession = {
  host: Host
  /** Where each agent was found, so the user's own are not conscripted. */
  agentSources?: Map<string, string>
  /** This user's own directory, which is where a reusable crew is kept. */
  home?: string
  store?: SettingsStore
  workspace: WorkspaceConfig
  agents: AgentDef[]
  config: Config
}

export type TeamIo = {
  write(text: string): void
  writeError(text: string): void
  color: boolean
}

/**
 * Runs the whole team the project declares.
 *
 * Each agent gets its own model, its own credentials and its own worktree, and
 * they can hand work to each other. The instruction goes to one of them — the
 * first, unless `--to` names another — and the run ends when nobody has
 * anything left to do.
 */
export async function runTeam(
  args: CliArgs,
  env: Record<string, string | undefined>,
  io: TeamIo,
  signal: AbortSignal,
  session: TeamSession,
): Promise<number> {
  const { team, unknown } = resolveTeam(
    session.agents,
    session.workspace.agents,
    { provider: session.config.providerId, model: session.config.model },
    (id) => hired(session.agentSources?.get(id), args.cwd, session.home ?? homedir()),
  )

  for (const id of unknown) {
    io.writeError(`config names agent "${id}", but no definition file was found for it\n`)
  }
  if (team.length === 0) {
    throw new NoTeamError(session.workspace.sources.agents)
  }

  const target = args.to ?? team[0]?.id
  const recipient = team.find((agent) => agent.id === target)
  if (!recipient) {
    throw new NoTeamError([
      `no agent named "${target}". Available: ${team.map((a) => a.id).join(', ')}`,
    ])
  }

  const credentials = resolveTeamCredentials(team, session.config.providerId, {
    env,
    ...(session.store ? { store: session.store } : {}),
  })
  if (credentials.missing.length > 0) {
    // Named all at once: fixing them one run at a time is how people give up.
    throw new MissingCredentialError(credentials.missing)
  }

  const renderer = createTeamRenderer({ write: io.write, color: io.color })
  /** Everything that happened, read back at the end into one verdict per job. */
  const seen: TeamEvent[] = []
  const stated = fromConfig(session.workspace.prices, 'the project')
  const priceFor = (model: string) => priceOf(stated, model) ?? bundledPriceOf(model)
  /** The agents as they were when the work stopped; the shutdown empties the host. */
  let agents: AgentSnapshot[] = []
  const costOf = (task: string) => jobCostSaid(agents, task, priceFor)
  /** What the run returns; the JSON at the end carries it too. */
  let code = 0
  const orchestration = await readOrchestration(session.workspace.sources.orchestration)
  // Named, or the first agent the project declares: a team always has a
  // leader, and making somebody name one before anything runs would be a
  // setting standing in the way of the thing it configures.
  const leader = leaderOf(session.workspace.leader, team)
  const host = createTeamHost({
    cwd: args.cwd,
    ...(orchestration ? { orchestration } : {}),
    // Named, or the first agent the project declares: a team always has a
    // leader, and making somebody name one before anything runs would be a
    // setting standing in the way of the thing it configures.
    ...(leader ? { leader } : {}),
    ...(session.workspace.toolCallsPerTurn
      ? { maxTurnsPerInstruction: session.workspace.toolCallsPerTurn }
      : {}),
    ...(session.workspace.check ? { check: session.workspace.check } : {}),
    ...(session.workspace.mergeOnDone === false ? { mergeOnDone: false } : {}),
    host: session.host,
    credentials,
    tools: session.host.registry.tools(),
    limits: DEFAULT_LIMITS,
    // Without git there is nothing to isolate with; the agents share the
    // directory and the summary says so rather than implying otherwise.
    isolate: true,
    onEvent: (event: TeamEvent) => {
      seen.push(event)
      renderer.handle(event)
    },
    defaultProvider: session.config.providerId,
    providerOptions: (id) => providerOptions(id, env, session.store),
  })

  const abort = () => void host.shutdown()
  signal.addEventListener('abort', abort, { once: true })

  try {
    for (const agent of team) await host.spawn(agent)

    io.write(`${summarise(host.list())}\n\n`)

    await host.tell(recipient.id, args.prompt)
    await host.idle()

    renderer.finish()
    agents = host.list()
    io.write(`\n${summarise(agents)}\n`)

    // What became of each job, in the harness's own words: checked, merged,
    // sent back, and what it cost beside what it would have cost. A run that
    // says "done" and exits 0 having done half the work is a green tick on a
    // branch nobody reads again, so the exit code follows the verdict.
    const outcomes = outcomeOf(seen)

    const changed = await reportDiffs(host, team, io)
    // A branch that has come home shows no diff against the repository it
    // came home to; saying nobody changed anything beside "merged" is a lie.
    if (changed === 0 && !outcomes.some((job) => job.merged)) {
      io.write('\nno agent changed any files\n')
    }
    if (outcomes.length > 0) io.write(`\n${summaryOf(outcomes, costOf).join('\n')}\n`)

    // `idle()` returns the instant nobody is busy, which on a stall is
    // immediately — so this printed the summary, printed the diffs and said
    // everything was fine. That is worse than hanging: a run that hangs trips
    // the CI timeout and somebody looks at it, and a run that exits 0 having
    // done half the work is a green tick on a branch nobody reads again.
    const waiting = host.stalled()
    if (waiting && waiting.length > 0) {
      for (const one of waiting) {
        io.writeError(
          `\n${one.from} asked ${one.to} to "${firstLine(one.text)}" and got no answer` +
            (one.cutShort ? `: its turn ended with ${one.cutShort}` : ', and it never took a turn'),
        )
      }
      io.writeError('\n')
      code = 1
      return code
    }

    code = signal.aborted ? 130 : exitCodeOf(outcomes)
    return code
  } finally {
    signal.removeEventListener('abort', abort)
    await host.shutdown()
    // Last of all, after the shutdown has said which checkouts it kept, so a
    // pipeline reads one line and finds everything in it.
    if (args.json) {
      const kept = seen.flatMap((event) =>
        event.type === 'workspace_kept' ? [{ task: event.task, path: event.path }] : [],
      )
      io.write(
        `${JSON.stringify({
          jobs: outcomeOf(seen).map((job) => ({ ...job, cost: costOf(job.task) ?? null })),
          agents: agents.map((agent) => ({
            id: agent.id,
            model: agent.model,
            task: agent.task,
            usage: agent.usage,
            turns: agent.turns,
          })),
          kept,
          exitCode: code,
        })}\n`,
      )
    }
  }
}

/** Prints one summary line per agent that touched something. */
async function reportDiffs(
  host: ReturnType<typeof createTeamHost>,
  team: AgentDef[],
  io: TeamIo,
): Promise<number> {
  let changed = 0

  for (const agent of team) {
    const diff = await host.diff(agent.id)
    if (diff.trim() === '') continue

    changed += 1
    const files = new Set(
      diff
        .split('\n')
        .filter((line) => line.startsWith('+++ '))
        .map((line) => line.replace(/^\+\+\+ (b\/|new file: )?/, '')),
    )
    io.write(`\n${agent.id}: ${[...files].join(', ')}\n`)
  }

  return changed
}

/** The first line of what was asked, which is enough to recognise it by. */
function firstLine(text: string): string {
  const line = text.split('\n').find((one) => one.trim() !== '') ?? ''
  return line.length > 60 ? `${line.slice(0, 57)}...` : line
}
