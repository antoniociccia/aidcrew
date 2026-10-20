// nested-worlds run | report | watch. Arguments are validated before anything is
// opened; what the run needs beyond the engine — a scheduler with its
// deciders, a report — comes in as deps, so tests can stand in for models.
import { parseArgs } from 'node:util'
import { z } from 'zod'
import type { Budget, RunConfig, RunStore, Scheduler } from './contracts.ts'
import { createRunner, recordFailure } from './runner.ts'
import { openStore } from './store/sqlite.ts'
import { startViewer, type Viewer } from './view/server.ts'
import { cliDeps } from './wiring.ts'

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

/** A real-model run spends money, so it starts small; --max-calls and --max-cost raise it. */
export const AIDCREW_BUDGET: Budget = {
  ...DEFAULT_BUDGET,
  maxCalls: 400,
  maxCostUsd: 2,
  maxConcurrent: 4,
}
export const AIDCREW_DEFAULTS = { provider: 'opencode-go', model: 'muse-spark-1.3-contributor' }

export const DEFAULT_PORT = 4747

export type CliCommand =
  | { cmd: 'run'; db: string; config: RunConfig; watch?: { port: number } }
  | { cmd: 'report'; db: string; runId: string }
  | { cmd: 'watch'; db: string; runId?: string; port: number }

export interface CliDeps {
  scheduler(config: RunConfig, store: RunStore, runId: string): Scheduler
  report(store: RunStore, runId: string): unknown | Promise<unknown>
}

const Int = (min: number, max: number) => z.coerce.number().int().min(min).max(max)

const RunArgs = z
  .object({
    seed: Int(0, 2 ** 32 - 1),
    condition: z.enum(['A', 'B']).default('A'),
    decider: z.enum(['fake', 'random', 'heuristic', 'oracle', 'openrouter', 'aidcrew', 'replay']),
    ticks: Int(1, 100_000).default(80),
    agents: Int(1, 8).default(4),
    db: z.string().min(1),
    'replay-of': z.string().min(1).optional(),
    'no-memory': z.boolean().default(false),
    model: z.string().min(1).optional(),
    provider: z.string().min(1).optional(),
    'max-calls': Int(1, 1_000_000).optional(),
    'max-cost': z.coerce.number().positive().max(1_000).optional(),
    'checkpoint-every': Int(1, 100_000).default(10),
    watch: z.boolean().default(false),
    port: Int(0, 65_535).default(DEFAULT_PORT),
  })
  .refine((a) => a.decider !== 'replay' || a['replay-of'] !== undefined, {
    message: '--decider replay needs --replay-of RUNID',
  })

const ReportArgs = z.object({ db: z.string().min(1), run: z.string().min(1) })

const WatchArgs = z.object({
  db: z.string().min(1),
  run: z.string().min(1).optional(),
  port: Int(0, 65_535).default(DEFAULT_PORT),
})

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
  provider: { type: 'string' },
  'max-calls': { type: 'string' },
  'max-cost': { type: 'string' },
  'checkpoint-every': { type: 'string' },
  watch: { type: 'boolean' },
  port: { type: 'string' },
} as const

export const USAGE = `usage:
  nested-worlds run --seed N --decider fake|random|heuristic|oracle|openrouter|aidcrew|replay --db PATH
                    [--condition A|B] [--ticks N] [--agents 1..8] [--replay-of RUNID] [--no-memory]
                    [--provider ID] [--model ID] [--max-calls N] [--max-cost USD]
                    [--checkpoint-every N] [--watch [--port N]]
  nested-worlds report --db PATH --run RUNID
  nested-worlds watch --db PATH [--run RUNID] [--port N]`

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
  if (cmd === 'watch') {
    const a = WatchArgs.parse(values)
    return {
      cmd: 'watch',
      db: a.db,
      port: a.port,
      ...(a.run === undefined ? {} : { runId: a.run }),
    }
  }
  if (cmd !== 'run') throw new Error(USAGE)
  const a = RunArgs.parse(values)
  const real = a.decider === 'aidcrew'
  const model = a.model ?? (real ? AIDCREW_DEFAULTS.model : undefined)
  const provider = a.provider ?? (real ? AIDCREW_DEFAULTS.provider : undefined)
  const budget: Budget = {
    ...(real ? AIDCREW_BUDGET : DEFAULT_BUDGET),
    ...(a['max-calls'] === undefined ? {} : { maxCalls: a['max-calls'] }),
    ...(a['max-cost'] === undefined ? {} : { maxCostUsd: a['max-cost'] }),
  }
  const config: RunConfig = {
    seed: a.seed,
    condition: a.condition,
    ticks: a.ticks,
    agents: a.agents,
    decider: a.decider,
    ablations: { memory: !a['no-memory'], nestedSims: false },
    budget,
    checkpointEvery: a['checkpoint-every'],
    designedExit: true,
    ...(provider === undefined ? {} : { provider }),
    ...(model === undefined ? {} : { model }),
    ...(a['replay-of'] === undefined ? {} : { replayOf: a['replay-of'] }),
  }
  return { cmd: 'run', db: a.db, config, ...(a.watch ? { watch: { port: a.port } } : {}) }
}

// A report already rendered as text is printed as it is; anything else as JSON.
function render(report: unknown): string {
  return typeof report === 'string' ? report : JSON.stringify(report, null, 2)
}

/**
 * Returns the viewer when the command started one: it keeps serving, and the
 * store stays open under it, until it is stopped (or the process ends).
 */
export async function main(
  argv: string[],
  deps: CliDeps,
  print: (line: string) => void,
): Promise<Viewer | null> {
  const command = parseCli(argv)
  const store = openStore(command.db)
  let server: Viewer | null = null
  const watch = (port: number, runId?: string) => {
    server = startViewer({ store, port })
    print(`watch: ${server.url}${runId === undefined ? '' : `?run=${runId}`}`)
  }
  const serving = (): Viewer | null => {
    const s: Viewer | null = server
    if (!s) return null
    return {
      url: s.url,
      stop() {
        s.stop()
        store.close()
      },
    }
  }
  try {
    if (command.cmd === 'report') {
      if (!store.run(command.runId)) throw new Error(`no run ${command.runId} in ${command.db}`)
      print(render(await deps.report(store, command.runId)))
      return null
    }
    if (command.cmd === 'watch') {
      if (command.runId !== undefined && !store.run(command.runId)) {
        throw new Error(`no run ${command.runId} in ${command.db}`)
      }
      watch(command.port, command.runId)
      return serving()
    }
    const runId = store.createRun(command.config)
    print(runId)
    if (command.watch) watch(command.watch.port, runId)
    try {
      const runner = createRunner({
        store,
        config: command.config,
        scheduler: deps.scheduler(command.config, store, runId),
        runId,
      })
      await runner.run()
    } catch (err) {
      // A run that died must not read as one still going, and its report says why.
      const reason = err instanceof Error ? err.message : String(err)
      recordFailure(store, runId, reason)
      print(render(await deps.report(store, runId)))
      throw new Error(`run ${runId} failed: ${reason}`)
    }
    print(render(await deps.report(store, runId)))
    return serving()
  } catch (err) {
    ;(server as Viewer | null)?.stop()
    server = null
    throw err
  } finally {
    // A viewer still serving reads this store; it closes it when stopped.
    if (!server) store.close()
  }
}

if (import.meta.main) {
  main(process.argv.slice(2), cliDeps, (line) => console.log(line)).catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  })
}
