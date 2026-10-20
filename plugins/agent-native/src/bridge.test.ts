import { afterEach, expect, test } from 'bun:test'
import type { LoopEvent, LoopOptions } from '@aidcrew/core'
import { startNativeBridge } from './bridge.ts'

const bridges: ReturnType<typeof startNativeBridge>[] = []
afterEach(() => {
  for (const bridge of bridges.splice(0)) bridge.close()
})
function fixture() {
  const calls: unknown[] = []
  const events: LoopEvent[] = []
  const options: LoopOptions = {
    provider: { id: 'test', async *send() {} },
    model: 'native',
    system: 'Role, roster and project instructions',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Shared task context' }] }],
    cwd: '/fixture',
    agentId: 'coder',
    tools: [
      {
        name: 'agent_send',
        description: 'Message the team',
        inputSchema: { type: 'object' },
        async execute(input, context) {
          calls.push({ input, cwd: context.cwd, agentId: context.agentId })
          return { content: 'delivered' }
        },
      },
    ],
  }
  let current: LoopOptions | undefined = options
  const bridge = startNativeBridge({
    getOptions: () => current,
    onHook: () => {},
    onEvent: (event) => {
      events.push(event)
    },
  })
  bridges.push(bridge)
  const config = bridge.mcpConfig.mcpServers.aidcrew
  const send = (body: unknown, headers: Record<string, string> = config.headers, path = '/mcp') =>
    fetch(new URL(path, config.url), {
      method: 'POST',
      headers: { ...headers, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  return {
    options,
    calls,
    events,
    bridge,
    send,
    clear: () => {
      current = undefined
    },
  }
}
test('authenticates native bridge calls before exposing team tools', async () => {
  const { send, calls } = fixture()
  expect((await send({ id: 1, method: 'tools/list' }, {})).status).toBe(401)
  const response = await send({ jsonrpc: '2.0', id: 2, method: 'tools/list' })
  expect((await response.json()).result.tools[0].name).toBe('agent_send')
  expect(calls).toEqual([])
})
test('executes the actual per-turn tool with agent ownership and enforces guards', async () => {
  const { send, calls, options } = fixture()
  const body = {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name: 'agent_send', arguments: { to: 'reviewer', message: 'Review' } },
  }
  expect((await (await send(body)).json()).result.content[0].text).toBe('delivered')
  expect(calls).toEqual([{ input: body.params.arguments, cwd: '/fixture', agentId: 'coder' }])
  options.hooks = [{ preToolCall: async () => ({ content: 'Denied', isError: true }) }]
  expect((await (await send(body)).json()).result.isError).toBe(true)
  expect(calls).toHaveLength(1)
})
test('refuses tools between turns and refreshes native prompt context', async () => {
  const { send, clear } = fixture()
  const hook = await send(
    { hook_event_name: 'UserPromptSubmit', prompt: 'hello' },
    undefined,
    '/hook',
  )
  expect((await hook.json()).hookSpecificOutput.additionalContext).toContain('Role, roster')
  clear()
  expect(
    (
      await (
        await send({ id: 1, method: 'tools/call', params: { name: 'agent_send', arguments: {} } })
      ).json()
    ).error,
  ).toBeDefined()
})
test('rejects browser cross-origin access and unknown tools', async () => {
  const { send, bridge } = fixture()
  const config = bridge.mcpConfig.mcpServers.aidcrew
  expect(
    (
      await send(
        { id: 1, method: 'tools/list' },
        { ...config.headers, Origin: 'https://evil.test' },
      )
    ).status,
  ).toBe(403)
  const result = await (
    await send({ id: 1, method: 'tools/call', params: { name: 'shell', arguments: {} } })
  ).json()
  expect(result.error).toBeDefined()
})

test('identifies the native agent and its checkout explicitly in every prompt context', async () => {
  const { send } = fixture()
  const response = await send(
    { hook_event_name: 'UserPromptSubmit', prompt: 'Who am I?' },
    undefined,
    '/hook',
  )
  const context = (await response.json()).hookSpecificOutput.additionalContext
  expect(context).toContain('Your AIDCrew agent ID is "coder".')
  expect(context).toContain('Your assigned checkout is "/fixture".')
})

const nativeTool = {
  tool_name: 'Bash',
  tool_use_id: 'toolu_native_1',
  tool_input: { command: 'private-command-secret' },
}

test('relays paired native activity without executing tools, exposing payloads or changing permissions', async () => {
  const { send, events, calls, options, bridge } = fixture()
  let guards = 0
  options.hooks = [
    {
      preToolCall: async () => {
        guards++
        return { content: 'Denied', isError: true }
      },
    },
  ]
  const before = await send({ hook_event_name: 'PreToolUse', ...nativeTool }, undefined, '/hook')
  expect(before.status).toBe(200)
  expect(await before.json()).toEqual({})
  const after = await send(
    {
      hook_event_name: 'PostToolUse',
      ...nativeTool,
      tool_response: { stdout: 'private-output-secret' },
      duration_ms: 25,
    },
    undefined,
    '/hook',
  )
  expect(await after.json()).toEqual({})
  expect(events).toEqual([
    { type: 'tool_start', id: 'native:toolu_native_1', name: 'native:Bash', input: {} },
    {
      type: 'tool_end',
      id: 'native:toolu_native_1',
      name: 'native:Bash',
      output: { content: 'Native operation completed' },
      durationMs: 25,
    },
  ])
  expect(JSON.stringify(events)).not.toContain('secret')
  expect(calls).toEqual([])
  expect(guards).toBe(0)
  for (const name of ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'])
    expect(bridge.settings.hooks[name]).toBeDefined()
})

test('reports native failures without copying errors and ignores duplicate or unmatched events', async () => {
  const { send, events } = fixture()
  const pre = { hook_event_name: 'PreToolUse', ...nativeTool }
  const failure = {
    hook_event_name: 'PostToolUseFailure',
    ...nativeTool,
    error: 'sensitive-error-secret',
    duration_ms: 12,
  }
  await send(failure, undefined, '/hook')
  await send(pre, undefined, '/hook')
  await send(pre, undefined, '/hook')
  await send(failure, undefined, '/hook')
  await send(failure, undefined, '/hook')
  expect(events).toHaveLength(2)
  expect(events[1]).toMatchObject({
    type: 'tool_end',
    output: {
      content: 'Native Bash command failed. Open the native terminal for full output.',
      isError: true,
    },
    durationMs: 12,
  })
  expect(JSON.stringify(events)).not.toContain('secret')
})

test('skips guarded aidcrew MCP hooks and native activity outside the active turn', async () => {
  const { send, events, clear } = fixture()
  await send(
    { hook_event_name: 'PreToolUse', ...nativeTool, tool_name: 'mcp__aidcrew__agent_send' },
    undefined,
    '/hook',
  )
  await send(
    {
      hook_event_name: 'PostToolUse',
      ...nativeTool,
      tool_name: 'mcp__aidcrew__agent_send',
      tool_response: {},
    },
    undefined,
    '/hook',
  )
  clear()
  await send({ hook_event_name: 'PreToolUse', ...nativeTool }, undefined, '/hook')
  expect(events).toEqual([])
})

test('validates native hook metadata before recording progress', async () => {
  const { send, events } = fixture()
  for (const body of [
    { hook_event_name: 'PreToolUse', ...nativeTool, tool_use_id: 4 },
    { hook_event_name: 'PreToolUse', ...nativeTool, tool_name: 'Bash\nforged' },
    { hook_event_name: 'PreToolUse', ...nativeTool, tool_input: 'bad' },
    { hook_event_name: 'PostToolUse', ...nativeTool },
    { hook_event_name: 'PostToolUseFailure', ...nativeTool, error: {} },
  ])
    expect((await send(body, undefined, '/hook')).status).toBe(400)
  expect(events).toEqual([])
})

test('classifies native shell failures without copying command output or credentials', async () => {
  const { send, events } = fixture()
  for (const [index, error, expected] of [
    [
      1,
      'Exit code 1\n(eval):1: no matches found: --include=*.ts\nprivate-output-secret',
      'Native Bash command failed: a shell glob matched no files. Quote glob patterns before retrying.',
    ],
    [
      2,
      'Exit code 127\nprivate-command-secret: command not found',
      'Native Bash command exited with code 127. Open the native terminal for full output.',
    ],
  ] as const) {
    const tool = { ...nativeTool, tool_use_id: `native_failure_${index}` }
    await send({ hook_event_name: 'PreToolUse', ...tool }, undefined, '/hook')
    await send({ hook_event_name: 'PostToolUseFailure', ...tool, error }, undefined, '/hook')
    expect(events.at(-1)).toMatchObject({
      type: 'tool_end',
      output: { content: expected, isError: true },
    })
  }
  expect(JSON.stringify(events)).not.toContain('secret')
  expect(JSON.stringify(events)).not.toContain('--include')
})
