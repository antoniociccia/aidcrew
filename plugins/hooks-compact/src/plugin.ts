import type { Hooks, Message, Plugin, Provider, TurnContext } from '@aidcrew/core'
import { accumulate } from '@aidcrew/core'
import { defineHooks, definePlugin } from '@aidcrew/plugin-sdk'
import type { Budget } from './decide.ts'
import { asMessage, BRIEF, DEFAULT_BUDGET, plan } from './decide.ts'

/**
 * Shortening a conversation that no longer fits.
 *
 * The oldest complete exchanges are replaced by a summary and the recent ones
 * are left alone, so an agent keeps what it is reasoning from and loses only
 * what it has already finished with.
 *
 * Who writes the summary is a choice worth having. By default the agent
 * summarises itself, which costs a turn on whatever it runs on. Naming a
 * cheaper model instead means the expensive one never spends its budget on
 * housekeeping — summarising is a small, mechanical job and a small model is
 * good at it. If the cheap one cannot be reached, the agent's own is used
 * rather than failing: a conversation that cannot be shortened is a session
 * that ends.
 *
 * Agents that are another coding program are left alone entirely. They keep
 * their own history and shorten it themselves, and a harness compacting a
 * conversation it does not hold would be shortening its own copy of nothing.
 */

export type CompactOptions = {
  /** Per agent, because a budget is a property of the model it runs on. */
  budgetFor(agentId: string): Budget
  /**
   * The provider that writes the summary for this agent, if one is set.
   *
   * Absent means the agent summarises itself. Set from `compactWith` in the
   * agent's config, which takes two forms: `provider/model` names both, and
   * is split at the first slash so a model id may itself hold one
   * (`zen/qwen/qwen3-8b`); a bare `provider` names only the provider, which
   * is then asked for the agent's own model — right only when it serves it.
   * `parseCompactWith` reads either form.
   */
  summariserFor(agentId: string): Provider | undefined
  /**
   * The model the summariser is asked for, when `compactWith` names one.
   *
   * Absent means the agent's own model. That was once the only choice, and
   * it broke the whole arrangement: a cheaper provider was named to spare
   * the expensive model's budget, then asked for the expensive model's id —
   * which it does not serve — so it failed every time, the expensive one
   * summarised anyway, and every shortening carried a note blaming the cheap
   * one. The fallback to the agent's own provider still uses the agent's own
   * model: the named one belongs to the provider it was named with.
   */
  summaryModelFor?(agentId: string): string | undefined
  /** The agent's own provider, used when there is no cheaper one or it fails. */
  providerFor(agentId: string): Provider | undefined
  /** Agents that shorten their own history and must be left alone. */
  handlesItsOwn(agentId: string): boolean
  /** Told what happened, so the interface can say so rather than going quiet. */
  onCompacted?(report: Report): void
}

export type Report = {
  agentId: string
  /** How many messages went into the summary. */
  summarised: number
  kept: number
  /** Which model wrote it, so a surprising summary can be traced. */
  by: string
  /** Set when the cheaper model was asked and could not answer. */
  fellBackBecause?: string
}

export function createCompactor(options: CompactOptions): Hooks {
  return defineHooks({
    async preTurn(messages: Message[], context: TurnContext): Promise<Message[] | undefined> {
      if (options.handlesItsOwn(context.agentId)) return undefined

      const decided = plan(messages, context.lastUsage, options.budgetFor(context.agentId))
      if (!decided.compact) return undefined

      const cheap = options.summariserFor(context.agentId)
      const own = options.providerFor(context.agentId)

      let summary: string | undefined
      let fellBackBecause: string | undefined
      let by = 'the agent'

      if (cheap) {
        const model = summaryModel(options, context)
        try {
          summary = await summarise(cheap, model, decided.summarise, context.signal)
          by = cheap.id
        } catch (cause) {
          // Reported rather than swallowed: an agent quietly summarising on the
          // expensive model is a bill nobody can explain later.
          fellBackBecause = cause instanceof Error ? cause.message : String(cause)
        }
      }

      if (summary === undefined && own) {
        summary = await summarise(own, context.model, decided.summarise, context.signal)
        by = own.id
      }

      // Nothing to replace it with means leaving it alone. A conversation that
      // is too long still works more often than one with a hole in it.
      if (summary === undefined || summary.trim() === '') return undefined

      options.onCompacted?.({
        agentId: context.agentId,
        summarised: decided.summarise.length,
        kept: decided.keep.length,
        by,
        ...(fellBackBecause ? { fellBackBecause } : {}),
      })

      return [asMessage(summary), ...decided.keep]
    },
  })
}

/** What the cheaper provider is asked for: the model named with it, else the agent's. */
function summaryModel(options: CompactOptions, context: TurnContext): string {
  return options.summaryModelFor?.(context.agentId) ?? context.model
}

async function summarise(
  provider: Provider,
  model: string,
  messages: Message[],
  signal: AbortSignal,
): Promise<string> {
  const turn = await accumulate(
    provider.send(
      {
        model,
        system: 'You summarise conversations so they can be continued.',
        messages: [...messages, { role: 'user', content: [{ type: 'text', text: BRIEF }] }],
        tools: [],
        maxTokens: 2048,
      },
      signal,
    ),
  )

  return turn.content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim()
}

/**
 * What `compactWith` names: a provider, and the model to ask it for if given.
 *
 * Split at the first slash only. Model ids on gateway providers carry a
 * slash of their own (`qwen/qwen3-8b`), and splitting at the last one would
 * hand the gateway half a model name.
 */
export function parseCompactWith(value: string): { provider: string; model?: string } {
  const slash = value.indexOf('/')
  if (slash === -1) return { provider: value }
  return { provider: value.slice(0, slash), model: value.slice(slash + 1) }
}

export function createCompactPlugin(options: CompactOptions): Plugin {
  return { name: 'hooks-compact', version: '0.0.0', hooks: createCompactor(options) }
}

export default definePlugin({ name: 'hooks-compact', version: '0.0.0' })

export type { Budget }
export { DEFAULT_BUDGET }
