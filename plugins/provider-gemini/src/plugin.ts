import { definePlugin, defineProvider } from '@aidcrew/plugin-sdk'
import { z } from 'zod'
import { createGeminiProvider } from './provider.ts'

export default definePlugin({
  name: 'provider-gemini',
  providers: [
    defineProvider({
      id: 'gemini',
      endpoint: 'https://generativelanguage.googleapis.com/v1beta',
      configSchema: z.object({
        apiKey: z.string().min(1, 'is required'),
        baseUrl: z
          .url({ protocol: /^https?$/ })
          .default('https://generativelanguage.googleapis.com/v1beta'),
      }),
      create: (config) => createGeminiProvider(config),
    }),
  ],
})
