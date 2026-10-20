// The real CliDeps: which decider each --decider names, and the report. Every
// live decider is recorded so its run can be replayed; a replay is not, since
// it only reads what an earlier run recorded. A live model's provider is
// found through `providerFor`, so tests can stand one in.
import type { CliDeps } from './cli.ts'
import type { Decider, RunConfig, RunStore } from './contracts.ts'
import { heuristicDecider, randomDecider } from './eval/baselines.ts'
import { renderReport } from './eval/escape.ts'
import { oracleDecider } from './eval/oracle.ts'
import { type AidcrewProvider, aidcrewDecider } from './llm/aidcrew.ts'
import { FakeDecider } from './llm/fake.ts'
import { providerFromAidcrew } from './llm/live.ts'
import { RecordingDecider } from './llm/recording.ts'
import { ReplayDecider } from './llm/replay.ts'
import { createScheduler } from './llm/scheduler.ts'
import { generateWorld } from './world/generate.ts'

/**
 * Room for a reasoning model to think and still answer: at 1024 a live run saw
 * 59 of its 90 answers come back empty, the whole budget spent thinking.
 */
const LIVE_MAX_TOKENS = 4096

export type ProviderFor = (providerId: string) => Promise<AidcrewProvider>

async function deciderFor(
  config: RunConfig,
  store: RunStore,
  providerFor: ProviderFor,
): Promise<Decider> {
  switch (config.decider) {
    case 'fake':
      return new FakeDecider(() => ({ type: 'wait' }))
    case 'replay':
      if (config.replayOf === undefined) throw new Error('--decider replay needs --replay-of RUNID')
      return new ReplayDecider(store, config.replayOf)
    case 'aidcrew': {
      const { provider, model } = config
      if (provider === undefined || model === undefined) {
        throw new Error('--decider aidcrew needs --provider ID and --model ID')
      }
      return aidcrewDecider({
        provider: await providerFor(provider),
        providerId: provider,
        model,
        maxTokens: LIVE_MAX_TOKENS,
      })
    }
    case 'openrouter':
      throw new Error(
        '--decider openrouter comes in phase 2; use fake, random, heuristic or oracle',
      )
    case 'random':
      return randomDecider(config.seed)
    case 'heuristic':
      return heuristicDecider(config.seed)
    case 'oracle':
      return oracleDecider(generateWorld(config.seed, config.agents).rules)
  }
}

export function makeCliDeps(providerFor: ProviderFor): CliDeps {
  return {
    async scheduler(config, store, runId) {
      const decider = await deciderFor(config, store, providerFor)
      const recorded =
        config.decider === 'replay' ? decider : new RecordingDecider(decider, store, runId)
      return createScheduler(recorded, config.budget)
    },
    report: renderReport,
  }
}

export const cliDeps: CliDeps = makeCliDeps((providerId) => providerFromAidcrew(providerId))
