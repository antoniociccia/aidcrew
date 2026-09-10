import { expect, test } from 'bun:test'
import { type BrowserCall, createBrowserTools } from './tools.ts'

const context = { cwd: '/tmp', agentId: 'test', signal: new AbortController().signal }
function harness(call?: BrowserCall) {
  const calls: { name: string; args: Record<string, unknown> }[] = []
  const tools = createBrowserTools(
    call ??
      (async (name, args) => {
        calls.push({ name, args })
        return { content: [{ type: 'text', text: `result:${name}` }] }
      }),
  )
  return {
    calls,
    run: (name: string, args: unknown) => {
      const tool = tools.find((tool) => tool.name === name)
      if (!tool) throw new Error(name)
      return tool.execute(args, context)
    },
  }
}

test('requires explicit page IDs instead of another agent selected page', async () => {
  const h = harness()
  expect((await h.run('browser_navigate', { action: 'reload' })).isError).toBe(true)
  expect(h.calls).toHaveLength(0)
})

test('diagnosis combines console/network and canvas measurements on the same page', async () => {
  const h = harness()
  const result = await h.run('browser_inspect', { action: 'diagnose', pageId: 7 })
  expect(result.isError).toBeUndefined()
  expect(h.calls.map((call) => call.name)).toEqual([
    'list_console_messages',
    'list_network_requests',
    'evaluate_script',
  ])
  expect(h.calls.every((call) => call.args.pageId === 7)).toBe(true)
  expect(h.calls[0]?.args.pageSize).toBe(10)
  expect(h.calls[2]?.args.function).toContain('getBoundingClientRect')
})

test('failed diagnostics stop with evidence rather than implying success', async () => {
  let calls = 0
  const h = harness(async () => {
    calls++
    return { isError: true, content: [{ type: 'text', text: 'target closed' }] }
  })
  expect(await h.run('browser_inspect', { action: 'diagnose', pageId: 2 })).toEqual({
    isError: true,
    content: 'target closed',
  })
  expect(calls).toBe(1)
})

test('multiplayer clients are isolated and do not steal desktop focus', async () => {
  const h = harness()
  await h.run('browser_navigate', {
    action: 'new',
    url: 'http://localhost:8787/',
    isolatedContext: 'player-b',
  })
  expect(h.calls[0]?.args).toEqual({
    url: 'http://localhost:8787/',
    isolatedContext: 'player-b',
    background: true,
    timeout: 10000,
  })
})

test('reload bypasses cache and screenshot help does not pretend to be vision', async () => {
  const h = harness()
  await h.run('browser_navigate', { action: 'reload', pageId: 2 })
  expect(h.calls[0]?.args).toEqual({ pageId: 2, type: 'reload', ignoreCache: true, timeout: 10000 })
  expect((await h.run('browser_help', {})).content).toContain('not image vision')
})
