// The real CliDeps: which decider each --decider names, and the report. Every
// live decider is recorded so its run can be replayed; a replay is not, since
// it only reads what an earlier run recorded.
import type { CliDeps } from './cli.ts'
import type { Decider, RunConfig, RunStore } from './contracts.ts'
import { heuristicDecider, randomDecider } from './eval/baselines.ts'
import { FakeDecider } from './llm/fake.ts'
import { RecordingDecider } from './llm/recording.ts'
import { ReplayDecider } from './llm/replay.ts'
import { createScheduler } from './llm/scheduler.ts'

function deciderFor(config: RunConfig, store: RunStore): Decider {
  switch (config.decider) {
    case 'fake':
      return new FakeDecider(() => ({ type: 'wait' }))
    case 'replay':
      if (config.replayOf === undefined) throw new Error('--decider replay needs --replay-of RUNID')
      return new ReplayDecider(store, config.replayOf)
    case 'openrouter':
      throw new Error(
        '--decider openrouter comes in phase 2; use fake, random, heuristic or oracle',
      )
    case 'random':
      return randomDecider(config.seed)
    case 'heuristic':
      return heuristicDecider(config.seed)
    case 'oracle':
      throw new Error(`--decider ${config.decider} is not wired yet`)
  }
}

export const cliDeps: CliDeps = {
  scheduler(config, store, runId) {
    const decider = deciderFor(config, store)
    const recorded =
      config.decider === 'replay' ? decider : new RecordingDecider(decider, store, runId)
    return createScheduler(recorded, config.budget)
  },
  report() {
    throw new Error('report is not wired yet')
  },
}
