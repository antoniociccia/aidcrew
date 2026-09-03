import { definePlugin, defineProvider, withPromptedTools } from '@aidcrew/plugin-sdk'
import { z } from 'zod'
import { listOpenAiModels } from './models.ts'
import { createOpenAiCompatProvider } from './provider.ts'

/**
 * Endpoints for services common enough to be worth not typing. This map lives
 * here and nowhere else: neither the core nor the CLI knows that Zen or
 * DeepSeek exist, which is the whole point of providers being plugins.
 *
 * Anything absent from this list still works through `openai-compat`, by
 * giving its base URL in the configuration.
 */
const PRESETS: Record<string, string> = {
  zen: 'https://opencode.ai/zen/v1',
  // Go is a separate endpoint under the same host, with its own billing: a Go
  // subscription is not spendable on the Zen one, which reports it as an
  // exhausted balance rather than as the wrong endpoint.
  'opencode-go': 'https://opencode.ai/zen/go/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  deepseek: 'https://api.deepseek.com/v1',
  openai: 'https://api.openai.com/v1',
  ollama: 'http://localhost:11434/v1',
}

const baseConfig = z.object({
  apiKey: z.string().min(1, 'is required'),
  headers: z.record(z.string(), z.string()).optional(),
  /**
   * Turn on for a model whose native tool calling is missing or broken — the
   * usual case behind a gateway and on locally served weights. The tools move
   * into the system prompt and calls are parsed back out of the text.
   */
  promptedTools: z.boolean().default(false),
  /** Which OpenAI dialect to speak; auto tries chat and falls back. */
  dialect: z.enum(['chat', 'responses', 'auto']).default('auto'),
  /**
   * How long the service may go without sending a byte: to start its answer,
   * and then between two chunks of it. Named with the unit, because a 120
   * read as seconds and stored as milliseconds is a clock that runs out
   * before the request has left the machine.
   */
  firstByteTimeoutMs: z.number().positive().optional(),
  idleTimeoutMs: z.number().positive().optional(),
})

/** The two limits as the provider takes them, only the ones that were set. */
function timeoutsIn(config: z.infer<typeof baseConfig>) {
  return {
    ...(config.firstByteTimeoutMs === undefined ? {} : { firstByteMs: config.firstByteTimeoutMs }),
    ...(config.idleTimeoutMs === undefined ? {} : { idleMs: config.idleTimeoutMs }),
  }
}

/** Wraps the provider in prompted tool calling when the config asks for it. */
function build(id: string, baseUrl: string, config: z.infer<typeof baseConfig>) {
  const provider = createOpenAiCompatProvider({
    id,
    baseUrl,
    apiKey: config.apiKey,
    dialect: config.dialect,
    timeouts: timeoutsIn(config),
    ...(config.headers ? { headers: config.headers } : {}),
  })
  return config.promptedTools ? withPromptedTools(provider) : provider
}

/** A preset knows its endpoint, but still allows one to be forced. */
function presetProvider(id: string, baseUrl: string) {
  return defineProvider({
    id,
    configSchema: baseConfig.extend({
      baseUrl: z.url({ protocol: /^https?$/ }).default(baseUrl),
    }),
    endpoint: baseUrl,
    create: (config) => build(id, config.baseUrl, config),
    listModels: (config, signal) => listOpenAiModels(config, signal),
  })
}

/** The escape hatch: any endpoint that speaks the dialect, named by the user. */
const generic = defineProvider({
  id: 'openai-compat',
  configSchema: baseConfig.extend({
    baseUrl: z.url({ protocol: /^https?$/ }),
  }),
  create: (config) => build('openai-compat', config.baseUrl, config),
  listModels: (config, signal) => listOpenAiModels(config, signal),
})

export default definePlugin({
  name: 'provider-openai-compat',
  providers: [
    ...Object.entries(PRESETS).map(([id, baseUrl]) => presetProvider(id, baseUrl)),
    generic,
  ],
})

export { PRESETS }
