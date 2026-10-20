import { expect, test } from 'bun:test'
import type { TeamEvent } from './agents/host.ts'
import { InProcessHost } from './agents/host.ts'
import type { SharedMemory } from './agents/shared.ts'
import type { LoopEvent, LoopOptions, LoopResult, Provider } from './loop.ts'
import { runAgentLoop, runGuardedTool } from './loop.ts'
import type { Message } from './types.ts'

const usage = { inputTokens: 2, outputTokens: 3 }
const def = (id: string) => ({
  id,
  description: `${id} role`,
  systemPrompt: `You are ${id}.`,
  task: 'shared-job',
})

async function finishRun(run: AsyncGenerator<LoopEvent, LoopResult>): Promise<LoopResult> {
  for (;;) {
    const step = await run.next()
    if (step.done) return step.value
  }
}

test('native execution receives host context and reports back through the normal handoff', async () => {
  let nativeOptions: LoopOptions | undefined
  let shared: SharedMemory | undefined
  let leaderTurns = 0
  const leaderMessages: Message[][] = []
  const events: TeamEvent[] = []
  const native: Provider = {
    id: 'native-test',
    send() {
      throw new Error('Native execution must not use send')
    },
    async *run(options) {
      nativeOptions = options
      yield { type: 'turn_start', turn: 1 }
      const note = options.tools.find((tool) => tool.name === 'task_note')
      await note?.execute(
        { text: 'The native member found the boundary.' },
        {
          agentId: options.agentId ?? '',
          cwd: options.cwd ?? '',
          signal: options.signal ?? new AbortController().signal,
        },
      )
      const content = [{ type: 'text' as const, text: 'Native review completed.' }]
      yield { type: 'assistant_turn', turn: { content, usage, stopReason: 'end_turn' } }
      return {
        messages: [...options.messages, { role: 'assistant', content }],
        usage,
        turns: 1,
        stopReason: 'end_turn',
      }
    },
  }
  const leader: Provider = {
    id: 'api-test',
    async *send(request) {
      leaderMessages.push(structuredClone(request.messages))
      if (leaderTurns++ === 0) {
        yield { type: 'tool_use_start', id: 'delegate', name: 'agent_send' }
        yield {
          type: 'tool_use_delta',
          id: 'delegate',
          partialInput: JSON.stringify({ to: 'reviewer', message: 'Review the boundary.' }),
        }
        yield { type: 'tool_use_end', id: 'delegate' }
        yield { type: 'done', stopReason: 'tool_use', usage }
      } else {
        yield { type: 'text_delta', text: 'Acknowledged.' }
        yield { type: 'done', stopReason: 'end_turn', usage }
      }
    },
  }
  const host = new InProcessHost({
    cwd: process.cwd(),
    isolate: false,
    tools: [],
    limits: { maxHops: 4 },
    leader: 'leader',
    sharedMemory: true,
    orchestration: 'Every review needs evidence.',
    providerFor: (agent) => (agent.id === 'reviewer' ? native : leader),
    onEvent: (event) => events.push(event),
    onShared: (_task, memory) => {
      shared = memory
    },
  })
  await host.spawn(def('leader'))
  await host.spawn({ ...def('reviewer'), yolo: true })
  await host.tell('leader', 'Delegate the review.')
  await host.idle()
  expect(nativeOptions?.system).toContain('You are reviewer.')
  expect(nativeOptions?.system).toContain('leader')
  expect(nativeOptions?.system).toContain('Every review needs evidence.')
  expect(nativeOptions?.cwd).toBe(process.cwd())
  expect(nativeOptions?.agentId).toBe('reviewer')
  expect(nativeOptions?.yolo).toBe(true)
  expect(nativeOptions?.tools.map((tool) => tool.name)).toEqual(
    expect.arrayContaining(['agent_send', 'task_note']),
  )
  expect(nativeOptions?.messages[0]?.content).toEqual([
    { type: 'text', text: '[from leader] Review the boundary.' },
  ])
  expect(shared?.notes[0]?.text).toBe('The native member found the boundary.')
  expect(JSON.stringify(leaderMessages)).toContain('Native review completed.')
  expect(events.some((event) => event.type === 'agent_failed')).toBe(false)
})

test('host cancellation reaches the native execution signal', async () => {
  let started: () => void = () => {}
  const entered = new Promise<void>((resolve) => {
    started = resolve
  })
  let cancelled = false
  let resets = 0
  const native: Provider = {
    id: 'native-test',
    send() {
      throw new Error('Native execution must not use send')
    },
    async *run(options) {
      yield { type: 'turn_start', turn: 1 }
      started()
      await new Promise<void>((resolve) =>
        options.signal?.addEventListener(
          'abort',
          () => {
            cancelled = true
            resolve()
          },
          { once: true },
        ),
      )
      return {
        messages: options.messages,
        usage: { inputTokens: 0, outputTokens: 0 },
        turns: 1,
        stopReason: 'aborted',
      }
    },
  }
  const host = new InProcessHost({
    cwd: process.cwd(),
    isolate: false,
    tools: [],
    limits: { maxHops: 3 },
    providerFor: () => native,
    permissionOwnerFor: () => 'provider',
    onAgentReset: () => {
      resets++
    },
    onEvent: () => {},
  })
  await host.spawn(def('reviewer'))
  await host.tell('reviewer', 'Work until stopped.')
  await entered
  expect(host.forget('reviewer')).toBe(false)
  expect(() => host.setModel('reviewer', { model: 'other' })).toThrow('current turn')
  expect(() => host.setYolo('reviewer', true)).toThrow('current turn')
  expect(resets).toBe(0)
  expect(host.cancel('reviewer')).toBe(true)
  await host.idle()
  expect(cancelled).toBe(true)
  expect(host.list()[0]?.status).toBe('idle')
})

test('API providers still execute through their streaming send method', async () => {
  const result = await finishRun(
    runAgentLoop({
      provider: {
        id: 'api',
        async *send() {
          yield { type: 'text_delta', text: 'API answer' }
          yield { type: 'done', usage, stopReason: 'end_turn' }
        },
      },
      model: 'model',
      system: '',
      tools: [],
      messages: [],
    }),
  )
  expect(result.messages.at(-1)?.content).toEqual([{ type: 'text', text: 'API answer' }])
})

test('native tool execution honors vetoes and redacts successful results through hooks', async () => {
  let executed = 0
  const tool = {
    name: 'read',
    description: '',
    inputSchema: {},
    execute: async () => {
      executed++
      return { content: 'private result' }
    },
  }
  const context = { cwd: '/worktree', agentId: 'reviewer', signal: new AbortController().signal }
  const call = { id: 'native-call', name: 'read', input: {} }
  const denied = runGuardedTool(call, tool, context, [
    { preToolCall: async () => ({ content: 'Denied by policy', isError: true }) },
  ])
  expect((await denied.next()).value).toEqual({ content: 'Denied by policy', isError: true })
  expect(executed).toBe(0)
  const allowed = runGuardedTool(call, tool, context, [
    { postToolCall: async () => ({ content: 'redacted' }) },
  ])
  expect((await allowed.next()).value).toEqual({ content: 'redacted' })
  expect(executed).toBe(1)
})

test('native tool execution cannot start after its owning turn is cancelled', async () => {
  let executed = false
  const controller = new AbortController()
  controller.abort()
  const run = runGuardedTool(
    { id: 'call', name: 'write', input: {} },
    {
      name: 'write',
      description: '',
      inputSchema: {},
      execute: async () => {
        executed = true
        return { content: 'written' }
      },
    },
    { cwd: '/worktree', agentId: 'reviewer', signal: controller.signal },
    [],
  )
  const result = await run.next()
  expect(executed).toBe(false)
  expect(result.value).toMatchObject({ isError: true })
})

test('agent removal closes external resources once on kill and shutdown', async () => {
  const removed: string[] = []
  const host = new InProcessHost({
    cwd: process.cwd(),
    isolate: false,
    tools: [],
    limits: { maxHops: 3 },
    providerFor: () => ({
      id: 'unused',
      send() {
        throw new Error('not used')
      },
    }),
    onEvent: () => {},
    onAgentRemoved: async (id, cwd) => {
      expect(cwd).toBe(process.cwd())
      removed.push(id)
    },
  })
  await host.spawn(def('first'))
  await host.spawn(def('second'))
  await host.kill('first')
  await host.kill('first')
  expect(removed).toEqual(['first'])
  await host.shutdown()
  expect(removed).toEqual(['first', 'second'])
})

test('native yolo preserves opt-in and resets idle resources before changing permissions', async () => {
  const resets: string[] = []
  const host = new InProcessHost({
    cwd: process.cwd(),
    isolate: false,
    tools: [],
    limits: { maxHops: 3 },
    providerFor: () => ({
      id: 'unused',
      send() {
        throw new Error('not used')
      },
    }),
    permissionOwnerFor: () => 'provider',
    onAgentReset: (id) => {
      resets.push(id)
    },
    onEvent: () => {},
  })
  await host.spawn({ ...def('native'), yolo: true })
  expect(host.list()[0]).toMatchObject({ permissionOwner: 'provider', yolo: true })
  expect(host.setYolo('native', true)).toBe(true)
  expect(resets).toEqual([])
  expect(host.setYolo('native', false)).toBe(true)
  expect(resets).toEqual(['native'])
  expect(host.list()[0]?.yolo).toBe(false)
  await host.shutdown()
})

test('forget and model changes reset persistent resources without removing the agent', async () => {
  const reset: string[] = []
  const host = new InProcessHost({
    cwd: process.cwd(),
    isolate: false,
    tools: [],
    limits: { maxHops: 3 },
    providerFor: () => ({
      id: 'unused',
      send() {
        throw new Error('not used')
      },
    }),
    onEvent: () => {},
    onAgentReset: (id) => {
      reset.push(id)
    },
  })
  await host.spawn({ ...def('native'), provider: 'native', model: 'first' })
  expect(host.forget('native')).toBe(true)
  expect(host.setModel('native', { model: 'second' })).toBe(true)
  expect(host.setModel('native', { provider: 'api' })).toBe(true)
  expect(host.setModel('native', { provider: 'api' })).toBe(true)
  expect(reset).toEqual(['native', 'native', 'native'])
  expect(host.list()).toHaveLength(1)
  await host.shutdown()
})
