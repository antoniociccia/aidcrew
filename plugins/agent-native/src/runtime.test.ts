import { afterEach, expect, test } from 'bun:test'
import type { LoopEvent, LoopOptions, LoopResult } from '@aidcrew/core'
import { startNativeTerminal } from './native-terminal.ts'
import {
  bindNativeDispatcher,
  closeNativeAgents,
  createNativeProvider,
  getNativeAgent,
  type NativeRuntimeDependencies,
} from './runtime.ts'

const fixture = `
const config = JSON.parse(process.argv[1]);
process.stdin.setRawMode(true);
async function post(url, body) {
 const response = await fetch(url, {method:'POST', headers:{...config.hook.headers,'Content-Type':'application/json'}, body:JSON.stringify(body)});
 if (!response.ok) throw new Error('Bridge request failed');
 return response.json();
}
async function turn(prompt) {
 const gate = await post(config.hook.url, {hook_event_name:'UserPromptSubmit',prompt});
 if (gate.decision === 'block') throw new Error('Prompt was blocked');
 if (prompt === 'Native activity') {
  await post(config.hook.url, {hook_event_name:'PreToolUse',tool_name:'Read',tool_use_id:'native-read',tool_input:{file_path:'README.md'}});
  await post(config.hook.url, {hook_event_name:'PostToolUse',tool_name:'Read',tool_use_id:'native-read',tool_input:{file_path:'README.md'},tool_response:'private file contents'});
 }
 const result = await post(config.mcp.url, {jsonrpc:'2.0',id:1,method:'tools/call',params:{name:'agent_send',arguments:{text:prompt}}});
 if (result.error) throw new Error('Tool call failed');
 if (prompt === 'Hold task') return;
 await post(config.hook.url, {hook_event_name:'Stop',last_assistant_message:'Finished: '+prompt});
}
let input = '';
process.stdin.on('data', async data => {
 input += data.toString();
 if (input.endsWith('\\r')) { const prompt = input.replace(/\\x1b\\[20[01]~/g,'').trim(); input=''; await turn(prompt); }
});
await post(config.hook.url,{hook_event_name:'SessionStart'});
await turn(config.prompt);
setInterval(()=>{},1000);
`

function fakeTerminal(counter: { starts: number }): NativeRuntimeDependencies['startTerminal'] {
  return (options, internal) => {
    counter.starts++
    const command = internal?.command ?? []
    const settings = JSON.parse(command[command.indexOf('--settings') + 1] ?? '{}')
    const mcp = JSON.parse(command[command.indexOf('--mcp-config') + 1] ?? '{}')
    return startNativeTerminal(options, {
      command: [
        process.execPath,
        '-e',
        fixture,
        JSON.stringify({
          hook: settings.hooks.UserPromptSubmit[0].hooks[0],
          mcp: mcp.mcpServers.aidcrew,
          prompt: command.at(-1),
        }),
      ],
    })
  }
}
async function collect(run: AsyncGenerator<LoopEvent, LoopResult>) {
  const events: LoopEvent[] = []
  let step = await run.next()
  while (!step.done) {
    events.push(step.value)
    step = await run.next()
  }
  return { events, result: step.value }
}
function options(
  provider: ReturnType<typeof createNativeProvider>,
  text: string,
  calls: string[],
): LoopOptions {
  return {
    provider,
    model: 'native',
    system: 'You are a reviewer in AIDCrew.',
    agentId: 'reviewer',
    cwd: process.cwd(),
    messages: [{ role: 'user', content: [{ type: 'text', text }] }],
    tools: [
      {
        name: 'agent_send',
        description: 'Send a team message',
        inputSchema: { type: 'object' },
        async execute(input) {
          if (
            typeof input !== 'object' ||
            !input ||
            !('text' in input) ||
            typeof input.text !== 'string'
          )
            throw new Error('Invalid fixture input')
          calls.push(input.text)
          return { content: 'Delivered' }
        },
      },
    ],
  }
}
afterEach(() => closeNativeAgents())

test('completes through authenticated native hooks and guarded team tools while retaining one PTY', async () => {
  const counter = { starts: 0 },
    calls: string[] = []
  const provider = createNativeProvider({
    assertSubscriptionLogin: async () => {},
    startTerminal: fakeTerminal(counter),
  })
  const first = await collect(provider.run(options(provider, 'First task', calls)))
  expect(first.result.messages.at(-1)?.content).toEqual([
    { type: 'text', text: 'Finished: First task' },
  ])
  expect(first.events.map((event) => event.type)).toEqual([
    'turn_start',
    'tool_start',
    'tool_end',
    'assistant_turn',
  ])
  const second = await collect(provider.run(options(provider, 'Next task', calls)))
  expect(second.result.stopReason).toBe('end_turn')
  expect(calls).toEqual(['First task', 'Next task'])
  expect(counter.starts).toBe(1)
})

test('adopts manual terminal prompts into the harness without typing them twice', async () => {
  const counter = { starts: 0 },
    calls: string[] = []
  const provider = createNativeProvider({
    assertSubscriptionLogin: async () => {},
    startTerminal: fakeTerminal(counter),
  })
  await collect(provider.run(options(provider, 'Initial task', calls)))
  let finish: (() => void) | undefined
  const done = new Promise<void>((resolve) => {
    finish = resolve
  })
  const unbind = bindNativeDispatcher(process.cwd(), async (_agent, prompt) => {
    await collect(provider.run(options(provider, prompt, calls)))
    finish?.()
  })
  try {
    const session = getNativeAgent(process.cwd(), 'reviewer')
    expect(session).toBeDefined()
    session?.write('Manual task\r')
    await done
    expect(calls).toEqual(['Initial task', 'Manual task'])
  } finally {
    unbind()
  }
})

test('abort closes the native process and releases its agent registry entry', async () => {
  const provider = createNativeProvider({
    assertSubscriptionLogin: async () => {},
    startTerminal: fakeTerminal({ starts: 0 }),
  })
  const controller = new AbortController()
  const run = provider.run({ ...options(provider, 'Abort task', []), signal: controller.signal })
  expect((await run.next()).value).toEqual({ type: 'turn_start', turn: 1 })
  controller.abort()
  expect((await run.next()).value).toMatchObject({ stopReason: 'aborted' })
  expect(getNativeAgent(process.cwd(), 'reviewer')).toBeUndefined()
})

test('closes a native turn when its event consumer stops early', async () => {
  const provider = createNativeProvider({
    assertSubscriptionLogin: async () => {},
    startTerminal: fakeTerminal({ starts: 0 }),
  })
  const run = provider.run(options(provider, 'Interrupted task', []))
  await run.next()
  await run.return({
    messages: [],
    stopReason: 'aborted',
    usage: { inputTokens: 0, outputTokens: 0 },
    turns: 0,
  })
  expect(getNativeAgent(process.cwd(), 'reviewer')).toBeUndefined()
})

test('refuses silently changing a live native session model and keeps its original session usable', async () => {
  const counter = { starts: 0 },
    calls: string[] = []
  const provider = createNativeProvider({
    assertSubscriptionLogin: async () => {},
    startTerminal: fakeTerminal(counter),
  })
  await collect(provider.run({ ...options(provider, 'First task', calls), model: 'sonnet' }))
  await expect(
    collect(provider.run({ ...options(provider, 'Changed model', calls), model: 'opus' })),
  ).rejects.toThrow('restart')
  await collect(provider.run({ ...options(provider, 'Original model', calls), model: 'sonnet' }))
  expect(calls).toEqual(['First task', 'Original model'])
  expect(counter.starts).toBe(1)
})

test('ignores stop hooks until the pending harness prompt has been accepted', async () => {
  const { startNativeBridge } = await import('./bridge.ts')
  let notify: Parameters<typeof startNativeBridge>[0]['onHook'] | undefined
  const provider = createNativeProvider({
    assertSubscriptionLogin: async () => {},
    startTerminal: fakeTerminal({ starts: 0 }),
    startBridge(config) {
      notify = config.onHook
      return startNativeBridge(config)
    },
  })
  const run = provider.run(options(provider, 'Real task', []))
  await run.next()
  await notify?.({ hook_event_name: 'Stop', last_assistant_message: 'Unrelated previous stop' })
  const completed = await collect(run)
  expect(completed.result.messages.at(-1)?.content).toEqual([
    { type: 'text', text: 'Finished: Real task' },
  ])
})

test('reports native failures and releases the failed process', async () => {
  const { startNativeBridge } = await import('./bridge.ts')
  let notify: Parameters<typeof startNativeBridge>[0]['onHook'] | undefined
  const provider = createNativeProvider({
    assertSubscriptionLogin: async () => {},
    startTerminal: fakeTerminal({ starts: 0 }),
    startBridge(config) {
      notify = config.onHook
      return startNativeBridge(config)
    },
  })
  const run = provider.run(options(provider, 'Failing task', []))
  await run.next()
  await notify?.({ hook_event_name: 'StopFailure', error: 'authentication_failed' })
  await expect(collect(run)).rejects.toThrow('Native Claude failed: authentication_failed')
  expect(getNativeAgent(process.cwd(), 'reviewer')).toBeUndefined()
})

for (const interrupt of ['\x03', '\x1b']) {
  test(`interrupting an active native turn with ${JSON.stringify(interrupt)} cannot leave the harness busy`, async () => {
    const provider = createNativeProvider({
      assertSubscriptionLogin: async () => {},
      startTerminal: fakeTerminal({ starts: 0 }),
    })
    const run = provider.run(options(provider, 'Hold task', []))
    await run.next()
    await run.next()
    const session = getNativeAgent(process.cwd(), 'reviewer')
    session?.write(interrupt)
    expect(getNativeAgent(process.cwd(), 'reviewer')).toBeUndefined()
    expect((await collect(run)).result.stopReason).toBe('aborted')
  })
}

test('expires manual adoption when dispatch returns without a matching harness turn', async () => {
  const { startNativeBridge } = await import('./bridge.ts')
  let notify: Parameters<typeof startNativeBridge>[0]['onHook'] | undefined
  const provider = createNativeProvider({
    assertSubscriptionLogin: async () => {},
    startTerminal: fakeTerminal({ starts: 0 }),
    adoptionTimeoutMs: 10,
    startBridge(config) {
      notify = config.onHook
      return startNativeBridge(config)
    },
  })
  await collect(provider.run(options(provider, 'Initial task', [])))
  const unbind = bindNativeDispatcher(process.cwd(), async () => {})
  try {
    const result = await Promise.race([
      Promise.resolve(
        notify?.({ hook_event_name: 'UserPromptSubmit', prompt: 'Orphan prompt' }),
      ).then(
        () => 'accepted',
        (error) => String(error),
      ),
      Bun.sleep(100).then(() => 'hung'),
    ])
    expect(result).toContain('did not accept')
  } finally {
    unbind()
  }
})

test('preserves idle interrupt keys and active terminal escape sequences', async () => {
  const forwarded: string[] = []
  const spawn = fakeTerminal({ starts: 0 })
  const provider = createNativeProvider({
    assertSubscriptionLogin: async () => {},
    startTerminal(config, internal) {
      const terminal = spawn(config, internal)
      return {
        ...terminal,
        write(data) {
          forwarded.push(typeof data === 'string' ? data : new TextDecoder().decode(data))
          terminal.write(data)
        },
      }
    },
  })
  await collect(provider.run(options(provider, 'Initial task', [])))
  const idle = getNativeAgent(process.cwd(), 'reviewer')
  idle?.write('\x03')
  idle?.write('\x1b')
  expect(idle?.closed).toBe(false)
  expect(forwarded).toEqual(['\x03', '\x1b'])
  idle?.close()
  const active = provider.run(options(provider, 'Hold task', []))
  await active.next()
  await active.next()
  const session = getNativeAgent(process.cwd(), 'reviewer')
  session?.write('\x1b[A')
  expect(session?.closed).toBe(false)
  expect(forwarded.at(-1)).toBe('\x1b[A')
  session?.write(new Uint8Array([3]))
  expect((await collect(active)).result.stopReason).toBe('aborted')
})

test('refuses a non-subscription login before launching a terminal and redacts auth metadata', async () => {
  const counter = { starts: 0 }
  const provider = createNativeProvider({
    startTerminal: fakeTerminal(counter),
    assertSubscriptionLogin: async () => {
      throw new Error('sensitive-auth-metadata')
    },
  })
  const failure = await collect(provider.run(options(provider, 'Subscription task', []))).catch(
    (error) => error,
  )
  expect(failure).toBeInstanceOf(Error)
  expect(String(failure)).toContain('subscription')
  expect(String(failure)).not.toContain('sensitive-auth-metadata')
  expect(counter.starts).toBe(0)
})

test('closes a previous native session when its subscription login is no longer valid', async () => {
  let allowed = true
  const provider = createNativeProvider({
    startTerminal: fakeTerminal({ starts: 0 }),
    assertSubscriptionLogin: async () => {
      if (!allowed) throw new Error('Invalid login')
    },
  })
  await collect(provider.run(options(provider, 'Initial task', [])))
  allowed = false
  await expect(collect(provider.run(options(provider, 'Next task', [])))).rejects.toThrow(
    'subscription',
  )
  expect(getNativeAgent(process.cwd(), 'reviewer')).toBeUndefined()
})

test('blocks manual native prompts when subscription authorization fails without hanging the active turn', async () => {
  const { startNativeBridge } = await import('./bridge.ts')
  let allowed = true
  let notify: Parameters<typeof startNativeBridge>[0]['onHook'] | undefined
  const provider = createNativeProvider({
    startTerminal: fakeTerminal({ starts: 0 }),
    assertSubscriptionLogin: async () => {
      if (!allowed) throw new Error('sensitive-auth-metadata')
    },
    startBridge(config) {
      notify = config.onHook
      return startNativeBridge(config)
    },
  })
  const run = provider.run(options(provider, 'Hold task', []))
  await run.next()
  await run.next()
  allowed = false
  const response = await notify?.({
    hook_event_name: 'UserPromptSubmit',
    prompt: 'Unauthorized prompt',
  })
  expect(response).toMatchObject({ decision: 'block' })
  expect(JSON.stringify(response)).not.toContain('sensitive-auth-metadata')
  await expect(collect(run)).rejects.toThrow('subscription')
  expect(getNativeAgent(process.cwd(), 'reviewer')).toBeUndefined()
})

test('aborting during subscription verification cannot launch a process', async () => {
  const controller = new AbortController(),
    counter = { starts: 0 }
  let checking: (() => void) | undefined
  const started = new Promise<void>((resolve) => {
    checking = resolve
  })
  const provider = createNativeProvider({
    startTerminal: fakeTerminal(counter),
    assertSubscriptionLogin: async () => {
      checking?.()
      await new Promise<void>(() => {})
    },
  })
  const completion = collect(
    provider.run({ ...options(provider, 'Aborted task', []), signal: controller.signal }),
  )
  await Promise.race([started, Bun.sleep(100)])
  controller.abort()
  const result = await completion
  expect(result.result.stopReason).toBe('aborted')
  expect(counter.starts).toBe(0)
})

test('streams native tool activity into the harness turn without exposing file contents', async () => {
  const provider = createNativeProvider({
    startTerminal: fakeTerminal({ starts: 0 }),
    assertSubscriptionLogin: async () => {},
  })
  const run = await collect(provider.run(options(provider, 'Native activity', [])))
  const starts = run.events.filter((event) => event.type === 'tool_start')
  expect(
    starts.some((event) => event.name === 'native:Read' && JSON.stringify(event.input) === '{}'),
  ).toBe(true)
  expect(
    run.events.some((event) => event.type === 'tool_end' && event.name === 'native:Read'),
  ).toBe(true)
  expect(JSON.stringify(run.events)).not.toContain('private file contents')
  expect(run.result.stopReason).toBe('end_turn')
})

test('launches opted-in native agents with bypass and rejects permission changes on a retained session', async () => {
  let command: readonly string[] = []
  const spawn = fakeTerminal({ starts: 0 })
  const provider = createNativeProvider({
    assertSubscriptionLogin: async () => {},
    startTerminal: (opts, internal) => {
      command = internal?.command ?? []
      return spawn(opts, internal)
    },
  })
  await collect(provider.run({ ...options(provider, 'First task', []), yolo: true }))
  expect(command.includes('--dangerously-skip-permissions')).toBe(true)
  await expect(
    collect(provider.run({ ...options(provider, 'Second task', []), yolo: false })),
  ).rejects.toThrow('permission mode changed')
})
