import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { McpClient, transportFor } from '@aidcrew/mcp-bridge'
import { defineHooks, definePlugin } from '@aidcrew/plugin-sdk'
import { z } from 'zod'
import { browserInstructions, createBrowserTools } from './tools.ts'

const configSchema = z.object({
  browserUrl: z.url().default('http://127.0.0.1:9222'),
  command: z.string().min(1).default('npx'),
  args: z.array(z.string()).default(['--yes', 'chrome-devtools-mcp@1.9.0']),
  timeoutMs: z.number().int().min(1000).max(60000).default(20000),
})

// An ordinary project/user plugin: no browser dependencies in the agent loop.
export default definePlugin({
  name: 'browser-chromium',
  version: '0.1.0',
  setup(host) {
    const config = configSchema.parse(host.config ?? {})
    let client: McpClient | undefined
    let connecting: Promise<McpClient> | undefined
    host.signal.addEventListener(
      'abort',
      () => {
        void client?.close()
      },
      { once: true },
    )
    return {
      hooks: defineHooks({
        instructions(context) {
          if (!context.tools.includes('browser_inspect')) return undefined
          const directory = dirname(fileURLToPath(import.meta.url))
          const runtime = existsSync(join(directory, 'runtime.py'))
            ? join(directory, 'runtime.py')
            : join(directory, '../runtime.py')
          return browserInstructions(runtime)
        },
      }),
      tools: createBrowserTools(async (name, args, signal) => {
        const bounded = AbortSignal.any([
          host.signal,
          signal,
          AbortSignal.timeout(config.timeoutMs),
        ])
        if (!connecting) {
          const server = {
            name: 'chromium',
            from: 'browser-chromium plugin',
            spec: {
              command: config.command,
              args: [
                ...config.args,
                `--browser-url=${config.browserUrl}`,
                '--no-usage-statistics',
                '--no-performance-crux',
                '--no-category-performance',
                '--no-category-emulation',
                '--page-id-routing',
                '--redact-network-headers',
              ],
              env: { CHROME_DEVTOOLS_MCP_NO_UPDATE_CHECKS: '1' },
            },
          }
          const next = new McpClient(server.name, transportFor(server, host.cwd))
          client = next
          connecting = next
            .connect(bounded)
            .then(() => next)
            .catch(async (error) => {
              await next.close()
              connecting = undefined
              throw error
            })
        }
        const ready = await connecting
        try {
          return await ready.callTool(name, args, bounded)
        } catch (error) {
          await ready.close()
          connecting = undefined
          throw error
        }
      }),
    }
  },
})
