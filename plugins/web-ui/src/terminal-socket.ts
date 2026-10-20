import type { ServerWebSocket, WebSocketHandler } from 'bun'
import { z } from 'zod'
import type { WebState } from './protocol.ts'

type NativeSession = {
  close(): void
  write(data: string): void
  resize(cols: number, rows: number): void
  history(): Uint8Array
  subscribe(listener: { data(data: Uint8Array): void; exit(code: number | null): void }): () => void
  readonly closed: boolean
}
export type TerminalSocketData = {
  authenticated: boolean
  sessionId?: string
  agentId?: string
  workspace?: string
  terminal?: NativeSession
  detach?: () => void
  timer?: ReturnType<typeof setTimeout>
}
const dimensions = {
  cols: z.number().int().min(2).max(500),
  rows: z.number().int().min(1).max(300),
}
const frameSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('auth'),
    token: z.string().max(512),
    sessionId: z.string(),
    agentId: z.string().min(1).max(240),
    ...dimensions,
  }),
  z.object({ type: z.literal('input'), data: z.string().max(100_000) }),
  z.object({ type: z.literal('resize'), ...dimensions }),
  z.object({ type: z.literal('stop') }),
])

export function terminalSockets(options: {
  snapshot(): WebState
  matches(token: string): boolean
  resolve(cwd: string, agentId: string): NativeSession | undefined
  stop(agentId: string): Promise<unknown>
}) {
  const sockets = new Set<ServerWebSocket<TerminalSocketData>>()
  const current = (ws: ServerWebSocket<TerminalSocketData>) => {
    const state = options.snapshot()
    return (
      state.ready &&
      !ws.data.terminal?.closed &&
      state.sessionId === ws.data.sessionId &&
      state.agents.some(
        (a) =>
          a.id === ws.data.agentId &&
          a.provider === 'claude-code' &&
          a.workspace === ws.data.workspace,
      )
    )
  }
  const send = (ws: ServerWebSocket<TerminalSocketData>, message: unknown) =>
    ws.send(JSON.stringify(message))
  const fail = (ws: ServerWebSocket<TerminalSocketData>, message: string) => {
    send(ws, { type: 'error', message })
    ws.close(1008, 'Terminal access refused')
  }
  const websocket: WebSocketHandler<TerminalSocketData> = {
    maxPayloadLength: 128_000,
    backpressureLimit: 1_000_000,
    closeOnBackpressureLimit: true,
    open(ws) {
      if (sockets.size >= 16) {
        ws.close(1013, 'Too many connections')
        return
      }
      sockets.add(ws)
      ws.data.timer = setTimeout(() => {
        if (!ws.data.authenticated) ws.close(1008, 'Authentication timed out')
      }, 5000)
    },
    async message(ws, raw) {
      try {
        const frame = frameSchema.parse(JSON.parse(typeof raw === 'string' ? raw : raw.toString()))
        if (!ws.data.authenticated) {
          if (frame.type !== 'auth' || !options.matches(frame.token)) {
            fail(ws, 'Authentication required')
            return
          }
          const state = options.snapshot()
          const agent = state.agents.find((a) => a.id === frame.agentId)
          if (
            !state.ready ||
            state.sessionId !== frame.sessionId ||
            !agent ||
            agent.provider !== 'claude-code'
          ) {
            fail(ws, 'The native agent or workspace is no longer available')
            return
          }
          const terminal = options.resolve(agent.workspace, agent.id)
          if (!terminal || terminal.closed) {
            fail(
              ws,
              'Send this agent an instruction in AIDCrew first, then open its native terminal.',
            )
            return
          }
          if (
            [...sockets].some(
              (other) =>
                other !== ws &&
                other.data.authenticated &&
                other.data.sessionId === state.sessionId &&
                other.data.agentId === agent.id,
            )
          ) {
            fail(ws, 'This agent terminal is already attached in another browser tab')
            return
          }
          clearTimeout(ws.data.timer)
          Object.assign(ws.data, {
            authenticated: true,
            sessionId: state.sessionId,
            agentId: agent.id,
            workspace: agent.workspace,
            terminal,
          })
          const decoder = new TextDecoder()
          ws.data.detach = terminal.subscribe({
            data(data) {
              if (!current(ws)) {
                ws.close(1008, 'Workspace changed')
                return
              }
              send(ws, { type: 'output', data: decoder.decode(data, { stream: true }) })
            },
            exit(code) {
              send(ws, { type: 'exit', code })
              ws.close(1000, 'Native agent exited')
            },
          })
          terminal.resize(frame.cols, frame.rows)
          send(ws, { type: 'ready' })
          send(ws, { type: 'output', data: decoder.decode(terminal.history(), { stream: true }) })
          return
        }
        if (!current(ws)) {
          fail(ws, 'Workspace changed')
          return
        }
        if (frame.type === 'input') ws.data.terminal?.write(frame.data)
        else if (frame.type === 'resize') ws.data.terminal?.resize(frame.cols, frame.rows)
        else if (frame.type === 'stop') {
          try {
            await options.stop(ws.data.agentId ?? '')
          } finally {
            ws.data.terminal?.close()
          }
        } else fail(ws, 'Already authenticated')
      } catch {
        fail(ws, 'Invalid terminal request')
      }
    },
    close(ws) {
      clearTimeout(ws.data.timer)
      ws.data.detach?.()
      sockets.delete(ws)
    },
  }
  const sweep = setInterval(() => {
    for (const ws of sockets)
      if (ws.data.authenticated && !current(ws)) ws.close(1008, 'Workspace changed')
  }, 750)
  sweep.unref()
  return {
    websocket,
    close() {
      clearInterval(sweep)
      for (const ws of sockets) ws.close(1001, 'Harness stopped')
    },
  }
}
