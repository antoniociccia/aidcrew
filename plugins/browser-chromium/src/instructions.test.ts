import { expect, test } from 'bun:test'
import type { CanonicalRequest, StreamDelta } from '@aidcrew/core'
import { runAgentLoop } from '@aidcrew/core'
import plugin from './plugin.ts'

async function exercise(browser: boolean) {
  const abort = new AbortController()
  const caps = await plugin.setup?.({
    cwd: '/tmp',
    home: '/tmp',
    config: {},
    stateDir: async () => '/tmp',
    signal: abort.signal,
  })
  const requests: CanonicalRequest[] = []
  const provider = {
    id: 'test',
    async *send(request: CanonicalRequest): AsyncGenerator<StreamDelta> {
      requests.push(structuredClone(request))
      if (browser && requests.length === 1) {
        yield { type: 'tool_use_start', id: '1', name: 'browser_inspect' }
        yield { type: 'tool_use_delta', id: '1', partialInput: '{"action":"pages"}' }
        yield { type: 'tool_use_end', id: '1' }
        yield { type: 'done', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 1 } }
      } else
        yield { type: 'done', stopReason: 'end_turn', usage: { inputTokens: 1, outputTokens: 1 } }
    },
  }
  const run = runAgentLoop({
    provider,
    model: 'test',
    system: 'Build the requested game.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Continue the project.' }] }],
    tools: browser
      ? [
          {
            name: 'browser_inspect',
            description: 'test',
            inputSchema: { type: 'object' },
            execute: async () => ({ content: '1: game' }),
          },
        ]
      : [],
    hooks: caps?.hooks ? [caps.hooks] : [],
    signal: abort.signal,
  })
  try {
    for (;;) {
      const next = await run.next()
      if (next.done) return { requests, history: next.value.messages }
    }
  } finally {
    abort.abort()
  }
}

test('a plain task gets browser guidance on the first request without reading a file or calling help', async () => {
  const { requests, history } = await exercise(true)
  expect(requests).toHaveLength(2)
  expect(requests[0]?.system).toContain('browser_inspect action=diagnose')
  expect(requests[0]?.system).not.toContain('BROWSER.md')
  expect(requests[1]?.system).toBe(requests[0]?.system)
  expect(requests[1]?.system.split('Browser capability')).toHaveLength(2)
  expect(JSON.stringify(history)).not.toContain('Browser capability')
})

test('agents without browser tools receive no browser instructions', async () => {
  const { requests } = await exercise(false)
  expect(requests[0]?.system).toBe('Build the requested game.')
})
