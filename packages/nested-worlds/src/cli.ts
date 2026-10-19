// nested-worlds run | report. Arguments are validated before anything is
// opened; what the run needs beyond the engine — a scheduler with its
// deciders, a report — comes in as deps, so tests can stand in for models.
import { parseArgs } from 'node:util'
import { z } from 'zod'
import type { Budget, RunConfig, RunStore, Scheduler } from './contracts.ts'
import { createRunner } from './runner.ts'
import { openStore } from './store/sqlite.ts'

export const DEFAULT_BUDGET: Budget = {
  maxCalls: 10_000,
  maxPromptTokens: 5_000_000,
  maxCompletionTokens: 1_000_000,
  maxCostUsd: 5,
  maxConcurrent: 4,
  maxSimDepth: 0,
  maxSims: 0,
  maxAgents: 8,
}

export type CliCommand =
  | { cmd: 'run'; db: string; config: RunConfig }
  | { cmd: 'report'; db: string; runId: string }

export interface CliDeps {
  scheduler(config: RunConfig, store: RunStore, runId: string): Scheduler
  report(store: RunStore, runId: string): unknown
}

const Int = (min: number, max: number) => z.coerce.number().int().min(min).max(max)

const RunArgs = z
  .object({
    seed: Int(0, 2 ** 32 - 1),
    condition: z.enum(['A', 'B']).default('A'),
    decider: z.enum(['fake', 'random', 'heuristic', 'oracle', 'openrouter', 'replay']),
    ticks: Int(1, 100_000).default(80),
    agents: Int(1, 8).default(4),
    db: z.string().min(1),
    'replay-of': z.string().min(1).optional(),
    'no-memory': z.boolean().default(false),
    model: z.string().min(1).optional(),
    'checkpoint-every': Int(1, 100_000).default(10),
  })
  .refine((a) => a.decider !== 'replay' || a['replay-of'] !== undefined, {
    message: '--decider replay needs --replay-of RUNID',
  })

const ReportArgs = z.object({ db: z.string().min(1), run: z.string().min(1) })

const OPTIONS = {
  seed: { type: 'string' },
  condition: { type: 'string' },
  decider: { type: 'string' },
  ticks: { type: 'string' },
  agents: { type: 'string' },
  db: { type: 'string' },
  run: { type: 'string' },
  'replay-of': { type: 'string' },
  'no-memory': { type: 'boolean' },
  model: { type: 'string' },
  'checkpoint-every': { type: 'string' },
} as const

export const USAGE = `usage:
  nested-worlds run --seed N --decider fake|random|heuristic|oracle|openrouter|replay --db PATH
                    [--condition A|B] [--ticks N] [--agents 1..8] [--replay-of RUNID] [--no-memory]
                    [--model ID] [--checkpoint-every N]
  nested-worlds report --db PATH --run RUNID`

export function parseCli(argv: string[]): CliCommand {
  const { positionals, values } = parseArgs({
    args: argv,
    options: OPTIONS,
    allowPositionals: true,
    strict: true,
  })
  const [cmd, ...rest] = positionals
  if (rest.length > 0) throw new Error(`unexpected arguments: ${rest.join(' ')}\n${USAGE}`)
  if (cmd === 'report') {
    const a = ReportArgs.parse(values)
    return { cmd: 'report', db: a.db, runId: a.run }
  }
  if (cmd !== 'run') throw new Error(USAGE)
  const a = RunArgs.parse(values)
  const config: RunConfig = {
    seed: a.seed,
    condition: a.condition,
    ticks: a.ticks,
    agents: a.agents,
    decider: a.decider,
    ablations: { memory: !a['no-memory'], nestedSims: false },
    budget: DEFAULT_BUDGET,
    checkpointEvery: a['checkpoint-every'],
    designedExit: true,
    ...(a.model === undefined ? {} : { model: a.model }),
    ...(a['replay-of'] === undefined ? {} : { replayOf: a['replay-of'] }),
  }
  return { cmd: 'run', db: a.db, config }
}

export async function main(
  argv: string[],
  deps: CliDeps,
  print: (line: string) => void,
): Promise<void> {
  const command = parseCli(argv)
  const store = openStore(command.db)
  try {
    if (command.cmd === 'report') {
      if (!store.run(command.runId)) throw new Error(`no run ${command.runId} in ${command.db}`)
      print(JSON.stringify(deps.report(store, command.runId), null, 2))
      return
    }
    const runId = store.createRun(command.config)
    const runner = createRunner({
      store,
      config: command.config,
      scheduler: deps.scheduler(command.config, store, runId),
      runId,
    })
    await runner.run()
    print(runId)
  } finally {
    store.close()
  }
}
