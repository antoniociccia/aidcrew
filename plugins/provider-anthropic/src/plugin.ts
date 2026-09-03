import { definePlugin, defineProvider } from '@aidcrew/plugin-sdk'
import { z } from 'zod'
import { createAnthropicProvider, listAnthropicModels } from './provider.ts'

export default definePlugin({
  name: 'provider-anthropic',
  providers: [
    defineProvider({
      id: 'anthropic',
      configSchema: z.object({
        apiKey: z.string().min(1, 'is required'),
        baseUrl: z.url({ protocol: /^https?$/ }).default('https://api.anthropic.com/v1'),
        version: z.string().default('2023-06-01'),
      }),
      // Declared so the interface can offer its models without keeping a
      // second copy of this address.
      endpoint: 'https://api.anthropic.com/v1',
      create: (config) => createAnthropicProvider(config),
      listModels: (config, signal) => listAnthropicModels(config, signal),
    }),
  ],
})
