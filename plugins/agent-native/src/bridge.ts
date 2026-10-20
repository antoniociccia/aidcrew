import { timingSafeEqual } from 'node:crypto'
import { type LoopEvent, type LoopOptions, runGuardedTool } from '@aidcrew/core'
import { z } from 'zod'

const hookSchema = z
  .object({
    hook_event_name: z.enum([
      'SessionStart',
      'UserPromptSubmit',
      'Stop',
      'StopFailure',
      'SessionEnd',
      'PreToolUse',
      'PostToolUse',
      'PostToolUseFailure',
    ]),
    session_id: z.string().optional(),
    prompt: z.string().max(500_000).optional(),
    last_assistant_message: z.string().max(1_000_000).optional(),
    error: z.string().optional(),
  })
  .passthrough()
export type BridgeHookEvent = z.infer<typeof hookSchema>
const nativeToolHooks = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'] as const
const nativeToolFields = {
  tool_name: z
    .string()
    .min(1)
    .max(128)
    .regex(/^[A-Za-z][A-Za-z0-9_.:-]*$/),
  tool_use_id: z
    .string()
    .min(1)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
  tool_input: z.record(z.string(), z.json()),
  duration_ms: z.number().finite().nonnegative().optional(),
}
const nativeToolSchema = z.discriminatedUnion('hook_event_name', [
  z.object({ hook_event_name: z.literal('PreToolUse'), ...nativeToolFields }),
  z.object({
    hook_event_name: z.literal('PostToolUse'),
    ...nativeToolFields,
    tool_response: z.json(),
  }),
  z.object({
    hook_event_name: z.literal('PostToolUseFailure'),
    ...nativeToolFields,
    error: z.string().max(1_000_000),
  }),
])
function nativeFailureSummary(tool: string, error: string): string {
  if (tool !== 'Bash') return 'Native operation failed'
  // Only fixed classifications and bounded exit codes leave the native terminal.
  if (/^(?:\(eval\)|zsh):\d+: no matches found:/m.test(error)) {
    return 'Native Bash command failed: a shell glob matched no files. Quote glob patterns before retrying.'
  }
  const code = /^Exit code ([0-9]{1,3})(?:\r?\n|$)/.exec(error)?.[1]
  if (code !== undefined && Number(code) <= 255) {
    return `Native Bash command exited with code ${Number(code)}. Open the native terminal for full output.`
  }
  return 'Native Bash command failed. Open the native terminal for full output.'
}

const rpcSchema = z.object({
  id: z.union([z.string(), z.number()]).optional(),
  method: z.string(),
  params: z.record(z.string(), z.unknown()).optional(),
})

export function startNativeBridge(options: {
  getOptions(): LoopOptions | undefined
  onHook(
    event: BridgeHookEvent,
  ): Promise<Record<string, unknown> | void> | Record<string, unknown> | void
  onEvent(event: LoopEvent): void
}) {
  const secret = crypto.randomUUID() + crypto.randomUUID()
  const auth = { Authorization: `Bearer ${secret}` }
  const pending = new Map<string, { name: string; started: number; owner: LoopOptions }>()
  function completeNativeActivity(event: z.infer<typeof nativeToolSchema>, owner: LoopOptions) {
    const id = `native:${event.tool_use_id}`
    const name = `native:${event.tool_name}`
    const started = pending.get(id)
    if (!started || started.name !== name) return
    pending.delete(id)
    if (started.owner !== owner) return
    const failed = event.hook_event_name === 'PostToolUseFailure'
    options.onEvent({
      type: 'tool_end',
      id,
      name,
      output: failed
        ? { content: nativeFailureSummary(event.tool_name, event.error), isError: true }
        : { content: 'Native operation completed' },
      durationMs: event.duration_ms ?? Math.max(0, Date.now() - started.started),
    })
  }
  function nativeActivity(event: z.infer<typeof nativeToolSchema>) {
    if (event.tool_name.startsWith('mcp__aidcrew__')) return
    const owner = options.getOptions()
    if (!owner || owner.signal?.aborted) {
      pending.clear()
      return
    }
    const id = `native:${event.tool_use_id}`
    const name = `native:${event.tool_name}`
    if (event.hook_event_name === 'PreToolUse') {
      if (pending.has(id) || pending.size >= 1024) return
      pending.set(id, { name, started: Date.now(), owner })
      // This is observation only: Claude keeps responsibility for execution and permissions.
      options.onEvent({ type: 'tool_start', id, name, input: {} })
      return
    }
    completeNativeActivity(event, owner)
  }
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    maxRequestBodySize: 1_200_000,
    async fetch(request) {
      const url = new URL(request.url)
      if (
        !['127.0.0.1', 'localhost'].includes(url.hostname) ||
        (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin)
      )
        return new Response('Invalid origin', { status: 403 })
      const given = Buffer.from(request.headers.get('Authorization') ?? '')
      const expected = Buffer.from(auth.Authorization)
      if (given.length !== expected.length || !timingSafeEqual(given, expected))
        return new Response('Authentication required', { status: 401 })
      if (request.method !== 'POST') return new Response(null, { status: 405 })
      if (!request.headers.get('Content-Type')?.includes('application/json'))
        return new Response('Expected JSON', { status: 415 })
      try {
        const body: unknown = await request.json()
        if (url.pathname === '/hook') {
          const event = hookSchema.parse(body)
          if (nativeToolHooks.some((name) => name === event.hook_event_name)) {
            nativeActivity(nativeToolSchema.parse(body))
            return Response.json({})
          }
          // Denials and interrupts may never emit a post hook; do not carry their IDs into another turn.
          if (
            ['UserPromptSubmit', 'Stop', 'StopFailure', 'SessionEnd'].includes(
              event.hook_event_name,
            )
          )
            pending.clear()
          const response = await options.onHook(event)
          if (response) return Response.json(response)
          if (event.hook_event_name === 'UserPromptSubmit') {
            const current = options.getOptions()
            if (!current)
              return Response.json({
                decision: 'block',
                reason: 'Send this instruction through AIDCrew to establish its task context.',
              })
            const context = current.messages
              .flatMap((message) =>
                message.content.flatMap((block) => (block.type === 'text' ? [block.text] : [])),
              )
              .join('\n\n')
            return Response.json({
              hookSpecificOutput: {
                hookEventName: 'UserPromptSubmit',
                additionalContext: `Your AIDCrew agent ID is ${JSON.stringify(current.agentId ?? '')}. Your assigned checkout is ${JSON.stringify(current.cwd ?? process.cwd())}.\n\n${current.system}\n\n${context}\n\nUse the aidcrew MCP tools to communicate with your team and update shared notes. Native Claude Code tools keep their own permissions.`,
              },
            })
          }
          return Response.json({})
        }
        if (url.pathname !== '/mcp') return new Response(null, { status: 404 })
        const rpc = rpcSchema.parse(body)
        if (rpc.id === undefined) return new Response(null, { status: 202 })
        const reply = (result: unknown) => Response.json({ jsonrpc: '2.0', id: rpc.id, result })
        const fail = (message: string) =>
          Response.json({ jsonrpc: '2.0', id: rpc.id, error: { code: -32602, message } })
        if (rpc.method === 'initialize')
          return reply({
            protocolVersion: '2025-03-26',
            capabilities: { tools: {} },
            serverInfo: { name: 'aidcrew', version: '1.0.0' },
          })
        if (rpc.method === 'ping') return reply({})
        const current = options.getOptions()
        if (rpc.method === 'tools/list')
          return reply({
            tools: (current?.tools ?? []).map(({ name, description, inputSchema }) => ({
              name,
              description,
              inputSchema,
            })),
          })
        if (rpc.method !== 'tools/call') return fail('Unknown method')
        if (!current || current.signal?.aborted) return fail('No active AIDCrew turn')
        const parsed = z
          .object({ name: z.string(), arguments: z.unknown().optional() })
          .parse(rpc.params)
        const tool = current.tools.find((one) => one.name === parsed.name)
        if (!tool) return fail('Tool not available to this agent')
        const id = crypto.randomUUID()
        const input = parsed.arguments ?? {}
        const started = Date.now()
        options.onEvent({ type: 'tool_start', id, name: tool.name, input })
        const run = runGuardedTool(
          { id, name: tool.name, input },
          tool,
          {
            agentId: current.agentId ?? '',
            cwd: current.cwd ?? process.cwd(),
            signal: current.signal ?? new AbortController().signal,
          },
          current.hooks ?? [],
          current.hookNames ?? [],
        )
        let step = await run.next()
        while (!step.done) {
          options.onEvent(step.value)
          step = await run.next()
        }
        const output = step.value
        options.onEvent({
          type: 'tool_end',
          id,
          name: tool.name,
          output,
          durationMs: Date.now() - started,
        })
        return reply({
          content: [{ type: 'text', text: output.content }],
          isError: output.isError ?? false,
        })
      } catch {
        return Response.json({ error: 'Invalid native bridge request' }, { status: 400 })
      }
    },
  })
  const address = `http://127.0.0.1:${server.port}`
  return {
    mcpConfig: { mcpServers: { aidcrew: { type: 'http', url: `${address}/mcp`, headers: auth } } },
    settings: {
      hooks: Object.fromEntries(
        [
          'SessionStart',
          'UserPromptSubmit',
          'Stop',
          'StopFailure',
          'SessionEnd',
          ...nativeToolHooks,
        ].map((name) => [
          name,
          [
            {
              hooks: [
                {
                  type: 'http',
                  url: `${address}/hook`,
                  headers: auth,
                  timeout: 120,
                  ...(name === 'UserPromptSubmit' ? { onFailure: 'block' } : {}),
                },
              ],
            },
          ],
        ]),
      ),
    },
    close: () => server.stop(true),
  }
}
