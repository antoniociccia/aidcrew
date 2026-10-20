import { afterEach, expect, test } from 'bun:test'
import type { WebState } from './protocol.ts'
import { type TerminalSocketData, terminalSockets } from './terminal-socket.ts'

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const close of cleanups.splice(0)) close()
})
function fixture() {
  const writes: string[] = []
  const sizes: number[][] = []
  const state: WebState = {
    sessionId: 'one',
    cwd: '/project',
    ready: true,
    target: 'native',
    sharedMemory: true,
    outstanding: 0,
    plugins: [],
    themes: [],
    lines: [],
    agents: [
      {
        id: 'native',
        provider: 'claude-code',
        model: 'native',
        workspace: '/project/work',
        status: 'idle',
        role: 'coder',
        task: 'task',
        queued: 0,
        behind: 0,
        yolo: false,
        isolated: true,
        turns: 0,
        activity: [],
        estimated: false,
        usage: { inputTokens: 0, outputTokens: 0 },
      },
    ],
  }
  let resolved = 0,
    detached = 0,
    stopped = 0,
    closed = 0
  const transport = terminalSockets({
    snapshot: () => state,
    matches: (token) => token === 'secret',
    resolve: (cwd, id) => {
      expect([cwd, id]).toEqual(['/project/work', 'native'])
      resolved++
      return {
        close: () => {
          closed++
        },
        closed: false,
        write: (text) => {
          writes.push(text)
        },
        resize: (cols, rows) => {
          sizes.push([cols, rows])
        },
        history: () => new TextEncoder().encode('native output'),
        subscribe: () => () => {
          detached++
        },
      }
    },
    stop: async () => {
      stopped++
    },
  })
  const server = Bun.serve<TerminalSocketData>({
    port: 0,
    hostname: '127.0.0.1',
    fetch(request, server) {
      if (server.upgrade(request, { data: { authenticated: false } })) return
      return new Response(null, { status: 400 })
    },
    websocket: transport.websocket,
  })
  cleanups.push(() => {
    transport.close()
    server.stop(true)
  })
  const connect = async () => {
    const socket = new WebSocket(`ws://127.0.0.1:${server.port}`)
    const frames: Record<string, unknown>[] = []
    socket.onmessage = (e) => frames.push(JSON.parse(String(e.data)))
    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      socket.onerror = () => reject(new Error('Socket failed'))
    })
    cleanups.push(() => socket.close())
    return { socket, frames }
  }
  return { state, writes, sizes, connect, counts: () => ({ resolved, detached, stopped, closed }) }
}
const auth = {
  type: 'auth',
  token: 'secret',
  sessionId: 'one',
  agentId: 'native',
  cols: 80,
  rows: 24,
}
test('refuses input before auth without accessing the native session', async () => {
  const f = fixture(),
    { socket, frames } = await f.connect()
  socket.send(JSON.stringify({ type: 'input', data: '/help\r' }))
  await Bun.sleep(30)
  expect(frames[0]?.type).toBe('error')
  expect(f.counts().resolved).toBe(0)
  expect(f.writes).toEqual([])
})
test('attaches only the selected agent and forwards native commands unchanged', async () => {
  const f = fixture(),
    { socket, frames } = await f.connect()
  socket.send(JSON.stringify(auth))
  await Bun.sleep(30)
  expect(frames.map((f) => f.type)).toEqual(['ready', 'output'])
  socket.send(JSON.stringify({ type: 'input', data: '/help\r' }))
  socket.send(JSON.stringify({ type: 'resize', cols: 100, rows: 30 }))
  await Bun.sleep(30)
  expect(f.writes).toEqual(['/help\r'])
  expect(f.sizes).toEqual([
    [80, 24],
    [100, 30],
  ])
  socket.close()
  await Bun.sleep(30)
  expect(f.counts().detached).toBe(1)
  expect(f.counts().stopped).toBe(0)
})
test('rejects stale sessions and invalid dimensions before forwarding input', async () => {
  const f = fixture(),
    { socket } = await f.connect()
  socket.send(JSON.stringify(auth))
  await Bun.sleep(30)
  f.state.sessionId = 'two'
  socket.send(JSON.stringify({ type: 'input', data: 'wrong workspace' }))
  await Bun.sleep(30)
  expect(f.writes).toEqual([])
  const next = await f.connect()
  next.socket.send(JSON.stringify({ ...auth, sessionId: 'two', cols: 99999 }))
  await Bun.sleep(30)
  expect(f.counts().resolved).toBe(1)
})

test('refuses a controller after its agent changes provider', async () => {
  const f = fixture(),
    { socket } = await f.connect()
  socket.send(JSON.stringify(auth))
  await Bun.sleep(30)
  const agent = f.state.agents[0]
  if (agent) agent.provider = 'other'
  socket.send(JSON.stringify({ type: 'input', data: 'stale controller' }))
  await Bun.sleep(30)
  expect(f.writes).toEqual([])
})

test('stops the native process even when the harness turn is idle', async () => {
  const f = fixture(),
    { socket } = await f.connect()
  socket.send(JSON.stringify(auth))
  await Bun.sleep(30)
  socket.send(JSON.stringify({ type: 'stop' }))
  await Bun.sleep(30)
  expect(f.counts().stopped).toBe(1)
  expect(f.counts().closed).toBe(1)
})
