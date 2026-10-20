import { z } from 'zod'
import type { SettingsStore } from './store.ts'

export class ConfigError extends Error {
  override readonly name = 'ConfigError'
}

export type Config = {
  providerId: string
  model: string
}

/**
 * The provider and model for a session.
 *
 * Neither has to be in the environment any more: both can be saved once with
 * `aidcrew config set`, which is what a settings screen writes. The
 * environment still wins when it is set, so a one-off run or a CI job can
 * override the saved values without changing them.
 *
 * Credentials are deliberately absent here — they are resolved per agent, so
 * a team can span several providers and plans.
 */
export function loadConfig(env: Record<string, string | undefined>, store?: SettingsStore): Config {
  const providerId = env.AIDCREW_PROVIDER ?? store?.get('default.provider') ?? 'zen'
  const model = env.AIDCREW_MODEL ?? store?.get('default.model')

  if (!model) {
    throw new ConfigError(
      'no model set. Choose one with:\n' +
        '  aidcrew config set default.model <model-id>\n' +
        'or pass AIDCREW_MODEL for a single run.',
    )
  }

  return { providerId, model }
}

/**
 * Provider options that are not credentials: things about *how* to talk to a
 * service rather than *who* is talking.
 *
 * Read from the environment first, then from the saved settings, so a run can
 * turn one on without changing what is stored.
 */
export function providerOptions(
  providerId: string,
  env: Record<string, string | undefined>,
  store?: SettingsStore,
  plugins: Record<string, Record<string, unknown>> = {},
): Record<string, unknown> {
  const prompted = env.AIDCREW_PROMPTED_TOOLS ?? store?.get(`provider.${providerId}.promptedTools`)

  const options: Record<string, unknown> = {
    ...projectStallLimits(providerId, plugins),
    ...(prompted ? { promptedTools: true } : {}),
  }
  const reasoning = env.AIDCREW_OPENROUTER_REASONING
  if (providerId === 'openrouter' && reasoning !== undefined) {
    try {
      options.reasoningByModel = JSON.parse(reasoning)
    } catch {
      throw new ConfigError('AIDCREW_OPENROUTER_REASONING must be valid JSON')
    }
    // These controls use OpenRouter's chat dialect. Do not silently fall back
    // to a different API that drops the configured reasoning policy.
    options.dialect = 'chat'
  }
  return options
}

const stallLimits = z
  .object({
    firstByteTimeoutMs: z.number().int().positive().max(600_000).optional(),
    idleTimeoutMs: z.number().int().positive().max(600_000).optional(),
  })
  .strict()

function projectStallLimits(providerId: string, plugins: Record<string, Record<string, unknown>>) {
  const table = plugins['provider-openai-compat']?.providers
  if (table === undefined) return {}
  const parsed = z.record(z.string(), stallLimits).safeParse(table)
  if (!parsed.success) throw new ConfigError('Invalid project provider stall limits')
  return Object.hasOwn(parsed.data, providerId) ? (parsed.data[providerId] ?? {}) : {}
}
