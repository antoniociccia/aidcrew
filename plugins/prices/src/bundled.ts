import type { Price } from './table.ts'

/**
 * List prices for the models people actually run, kept in the repository.
 *
 * A price list in a repository is stale by the time anybody reads it, which is
 * why `fromListing` asks the service first and this is consulted only when
 * neither the project nor the service says anything. But the alternative to a
 * stale figure is no figure, and that is what a paid gateway which publishes
 * no prices produced: Zen answers `/models` with
 * `{"id":"claude-opus-5","object":"model"}` and not a word about money, so the
 * screen showed nothing at all for a service billing every token. An estimate
 * that says it is one beats a blank where a bill is.
 *
 * Dollars per token, which is dollars per million divided by a million, and
 * the form every provider that publishes prices publishes them in. Cache rates
 * follow each family's published multiplier where there is one — Anthropic
 * reads at a tenth and writes at 1.25x, OpenAI and Google read at a tenth and
 * charge nothing to write — rather than being guessed per model.
 */

export const BUNDLED_FROM = 'the bundled list (checked September 2026)'

/** Dollars per million tokens, which is how every service publishes them. */
type PerMillion = {
  input: number
  output: number
  /** A tenth of input unless the family says otherwise. */
  cacheRead?: number
  /** Anthropic charges to write a cache entry; most others do not. */
  cacheWrite?: number
}

/**
 * By model id, normalised.
 *
 * The longest matching name wins, so a family entry can stand behind the
 * specific ones: `gpt-5` prices every gpt-5 variant nobody has listed, while
 * `gpt-5-mini` prices the one that is a tenth of it.
 */
const LIST: Record<string, PerMillion> = {
  // Anthropic. Opus 5 and its predecessors at the Opus rate, Sonnet at a
  // fifth of it, Haiku at a twentieth; cache read at 0.1x, write at 1.25x.
  'claude-opus-5': { input: 5, output: 25 },
  'claude-opus-4-8': { input: 5, output: 25 },
  'claude-opus-4-7': { input: 5, output: 25 },
  'claude-opus-4-6': { input: 5, output: 25 },
  'claude-opus-4-5': { input: 5, output: 25 },
  'claude-opus-4': { input: 15, output: 75 },
  'claude-fable-5-1': { input: 10, output: 50 },
  'claude-fable-5': { input: 10, output: 50 },
  'claude-sonnet-5': { input: 2, output: 10 },
  'claude-sonnet-4-6': { input: 3, output: 15 },
  'claude-sonnet-4-5': { input: 3, output: 15 },
  'claude-sonnet-4': { input: 3, output: 15 },
  'claude-haiku-4-5': { input: 1, output: 5 },
  'claude-haiku-4': { input: 1, output: 5 },
  'claude-3-5-haiku': { input: 0.8, output: 4 },

  // OpenAI. The 5 line at $1.25/$10, its mini at a fifth and its nano at a
  // twentieth; the o-series reasoning models priced apart, o3-pro ten times
  // o3. Cached input at a tenth, and nothing to write.
  'gpt-5': { input: 1.25, output: 10, cacheWrite: 0 },
  'gpt-5-chat': { input: 1.25, output: 10, cacheWrite: 0 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheWrite: 0 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheWrite: 0 },
  'gpt-5-codex': { input: 1.25, output: 10, cacheWrite: 0 },
  'gpt-4-1': { input: 2, output: 8, cacheWrite: 0 },
  'gpt-4-1-mini': { input: 0.4, output: 1.6, cacheWrite: 0 },
  'gpt-4o': { input: 2.5, output: 10, cacheWrite: 0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheWrite: 0 },
  o3: { input: 2, output: 8, cacheWrite: 0 },
  'o3-pro': { input: 20, output: 80, cacheWrite: 0 },
  'o3-mini': { input: 1.1, output: 4.4, cacheWrite: 0 },
  'o4-mini': { input: 1.1, output: 4.4, cacheWrite: 0 },

  // Google. Pro at $1.25/$10 under two hundred thousand tokens, Flash a
  // tenth of it, Flash-Lite a tenth again; cached input at a quarter.
  'gemini-3': { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
  'gemini-3-pro': { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
  'gemini-3-1-pro': { input: 2, output: 12, cacheRead: 0.5, cacheWrite: 0 },
  'gemini-3-flash': { input: 0.5, output: 3, cacheRead: 0.125, cacheWrite: 0 },
  'gemini-3-5-flash': { input: 0.75, output: 3.75, cacheRead: 0.19, cacheWrite: 0 },
  'gemini-3-6-flash': { input: 0.75, output: 3.75, cacheRead: 0.19, cacheWrite: 0 },
  'gemini-3-7-flash': { input: 0.75, output: 3.75, cacheRead: 0.19, cacheWrite: 0 },
  'gemini-3-8-flash': { input: 0.75, output: 3.75, cacheRead: 0.19, cacheWrite: 0 },
  'gemini-3-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.06, cacheWrite: 0 },
  'gemini-3-1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.06, cacheWrite: 0 },
  'gemini-3-5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 },
  'gemini-2-5-pro': { input: 1.25, output: 10, cacheRead: 0.31, cacheWrite: 0 },
  'gemini-2-5-flash': { input: 0.3, output: 2.5, cacheRead: 0.075, cacheWrite: 0 },

  // The open-weight families, which are where a mixed team saves its money.
  deepseek: { input: 0.28, output: 0.42, cacheRead: 0.028, cacheWrite: 0 },
  'deepseek-v4': { input: 0.22, output: 0.66, cacheRead: 0.022, cacheWrite: 0 },
  'deepseek-v4-pro': { input: 1.04, output: 2.08, cacheRead: 0.104, cacheWrite: 0 },
  'deepseek-v4-flash': { input: 0.09, output: 0.17, cacheRead: 0.009, cacheWrite: 0 },
  'kimi-k2': { input: 0.6, output: 2.5, cacheWrite: 0 },
  'kimi-k2-7': { input: 0.66, output: 3.4, cacheWrite: 0 },
  'kimi-k3': { input: 3, output: 15, cacheWrite: 0 },
  qwen3: { input: 0.4, output: 1.2, cacheWrite: 0 },
  'qwen3-8-max': { input: 2, output: 6, cacheWrite: 0 },
  'qwen3-8-flash': { input: 0.15, output: 0.47, cacheWrite: 0 },
  'qwen3-7-max': { input: 1.48, output: 4.42, cacheWrite: 0 },
  glm: { input: 0.6, output: 2.2, cacheWrite: 0 },
  'glm-5': { input: 0.6, output: 1.92, cacheWrite: 0 },
  'glm-5-3-flash': { input: 0.07, output: 0.25, cacheWrite: 0 },
  minimax: { input: 0.3, output: 1.2, cacheWrite: 0 },
  'minimax-m2': { input: 0.3, output: 1.2, cacheWrite: 0 },
  'minimax-m3': { input: 0.3, output: 1.2, cacheWrite: 0 },
  'grok-4': { input: 3, output: 15, cacheWrite: 0 },
  'grok-4-6': { input: 2, output: 6, cacheWrite: 0 },
  'grok-code': { input: 0.2, output: 1.5, cacheWrite: 0 },
  'mistral-large': { input: 2, output: 6, cacheWrite: 0 },
  'mistral-medium': { input: 1.5, output: 7.5, cacheWrite: 0 },
  'llama-4': { input: 0.2, output: 0.7, cacheWrite: 0 },
}

/** The names, longest first, so a specific entry beats the family behind it. */
const NAMES = Object.keys(LIST).sort((a, b) => b.length - a.length)

/**
 * A model id in the one spelling this list is keyed by.
 *
 * The same model reaches us as `claude-opus-4.5`, `anthropic/claude-opus-4-5`
 * and `claude-opus-4-5-20250929`, and a table that missed two of those would
 * report nothing for a model it holds the price of.
 */
export function normaliseModelId(model: string): string {
  return model
    .toLowerCase()
    .replace(/^[^/]+\//, '')
    .replaceAll('.', '-')
    .replace(/[-@]\d{4}-?\d{2}-?\d{2}$/, '')
    .replace(/-latest$/, '')
}

/**
 * What this model costs per token, according to the list.
 *
 * Nothing for a model nobody here has heard of, which is honest and is what
 * lets `costOf` leave a blank rather than invent a number.
 */
export function bundledPriceOf(model: string): Price | undefined {
  const id = normaliseModelId(model)

  // A gateway marks its free tier in the id, and a free model priced at the
  // paid rate puts money on the screen for work that cost nothing. It is a
  // fact about the name rather than an estimate, so it is not marked as one.
  if (id.endsWith('-free')) {
    return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, from: 'free at this service' }
  }

  const name = NAMES.find((known) => id === known || id.startsWith(`${known}-`))
  const found = name === undefined ? undefined : LIST[name]
  if (!found) return undefined

  const perToken = (dollars: number): number => dollars / 1_000_000
  return {
    input: perToken(found.input),
    output: perToken(found.output),
    cacheRead: perToken(found.cacheRead ?? found.input / 10),
    cacheWrite: perToken(found.cacheWrite ?? found.input * 1.25),
    from: BUNDLED_FROM,
    estimated: true,
  }
}
