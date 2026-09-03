import type { Plugin, Provider, ProviderDefinition } from '@aidcrew/core'
import { CONTRACT } from '@aidcrew/core'
import type { z } from 'zod'

/**
 * Declares a plugin. Purely a typing aid — it returns what it is given — so
 * that a plugin file is a plain module with a default export and nothing about
 * loading it depends on this package being present.
 */
export function definePlugin(plugin: Plugin): Plugin {
  // Stamped rather than asked for. The SDK is the one thing that knows which
  // contract this plugin compiled against; an author who types the number
  // gets it wrong, and one who is asked for it lets it go stale.
  return { contract: CONTRACT, ...plugin }
}

export type ProviderSpec<S extends z.ZodType> = {
  /** How config and agent definitions refer to this provider. */
  id: string
  /** Validated before `create` runs; its errors are what the user will read. */
  configSchema: S
  create(config: z.infer<S>): Provider
  /** Fixed address, when this provider has one. */
  endpoint?: string
  /** Which models it will answer for, when it has a way to be asked. */
  listModels?(config: z.infer<S>, signal: AbortSignal): Promise<string[]>
}

/**
 * Declares a provider, with its configuration validated at load time.
 *
 * A provider is described rather than built: credentials and endpoint arrive
 * from the host, so the plugin never needs to know whether they came from the
 * environment, a config file or a keychain.
 */
export function defineProvider<S extends z.ZodType>(spec: ProviderSpec<S>): ProviderDefinition {
  /** Never echoes the config itself: it holds the API key. */
  const check = (config: unknown): z.infer<S> => {
    const parsed = spec.configSchema.safeParse(config)
    if (!parsed.success) {
      const problems = parsed.error.issues
        .map((issue) => `${issue.path.join('.') || 'config'}: ${issue.message}`)
        .join('; ')
      throw new Error(`invalid configuration for provider "${spec.id}": ${problems}`)
    }
    return parsed.data
  }

  const listModels = spec.listModels
  return {
    id: spec.id,
    ...(spec.endpoint ? { endpoint: spec.endpoint } : {}),
    // Absent rather than present-and-empty when a provider cannot answer: the
    // interface shows a free-text field on absence, and an empty list would
    // instead tell someone this provider has no models at all.
    ...(listModels
      ? {
          // Async so a bad config arrives as a rejected promise rather than a
          // synchronous throw: every caller of this awaits it, and one that
          // wraps the await in a catch would otherwise miss the throw entirely.
          listModels: async (config: unknown, signal: AbortSignal) =>
            listModels(check(config), signal),
        }
      : {}),
    create(config: unknown): Provider {
      return spec.create(check(config))
    },
  }
}
