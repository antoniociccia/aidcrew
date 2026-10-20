import type { LoopEvent, LoopOptions, LoopResult, Message, Provider } from '@aidcrew/core'
import { type BridgeHookEvent, startNativeBridge } from './bridge.ts'
import { nativeCommand, nativeModel, nativePrompt, pastePrompt } from './command.ts'
import { startNativeTerminal } from './native-terminal.ts'
import { assertSubscriptionLogin } from './subscription.ts'

type Listener = { data: (data: Uint8Array) => void; exit: (code: number | null) => void }
type PendingEvent =
  | { kind: 'event'; event: LoopEvent }
  | { kind: 'done'; text: string }
  | { kind: 'error'; error: Error }
  | { kind: 'aborted' }
function eventQueue() {
  const values: PendingEvent[] = []
  let wake: (() => void) | undefined
  return {
    push(value: PendingEvent) {
      values.push(value)
      wake?.()
      wake = undefined
    },
    async next(): Promise<PendingEvent> {
      while (!values.length)
        await new Promise<void>((resolve) => {
          wake = resolve
        })
      const value = values.shift()
      if (!value) throw new Error('Native event queue was empty')
      return value
    },
  }
}
type ActiveRun = { options: LoopOptions; events: ReturnType<typeof eventQueue>; submitted: boolean }
type Adoption = { resolve: () => void; reject: (error: Error) => void }
type NativeSession = {
  cwd: string
  agentId: string
  model: string | undefined
  yolo: boolean
  adoptionTimeoutMs: number
  checkLogin: typeof assertSubscriptionLogin
  lifetime: AbortController
  active: ActiveRun | undefined
  adoption: Adoption | undefined
  terminal: ReturnType<typeof startNativeTerminal> | undefined
  bridge: ReturnType<typeof startNativeBridge> | undefined
  listeners: Set<Listener>
  closed: boolean
}
const sessions = new Map<string, NativeSession>()
const dispatchers = new Map<string, (agentId: string, prompt: string) => Promise<unknown>>()
const key = (cwd: string, agentId: string) => JSON.stringify([cwd, agentId])
const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error))

function closeSession(session: NativeSession) {
  if (session.closed) return
  session.closed = true
  session.lifetime.abort()
  sessions.delete(key(session.cwd, session.agentId))
  const error = new Error('Native Claude session closed')
  session.active?.events.push({ kind: 'error', error })
  session.adoption?.reject(error)
  session.terminal?.close()
  session.bridge?.close()
}

export function closeNativeAgents(cwd?: string) {
  for (const session of sessions.values()) if (!cwd || session.cwd === cwd) closeSession(session)
}

export function closeNativeAgent(cwd: string, agentId: string) {
  const session = sessions.get(key(cwd, agentId))
  if (session) closeSession(session)
}

export function bindNativeDispatcher(
  cwd: string,
  dispatch: (agentId: string, prompt: string) => Promise<unknown>,
) {
  dispatchers.set(cwd, dispatch)
  return () => {
    if (dispatchers.get(cwd) === dispatch) dispatchers.delete(cwd)
  }
}

export function getNativeAgent(cwd: string, agentId: string) {
  const session = sessions.get(key(cwd, agentId))
  if (!session?.terminal || session.closed) return undefined
  const terminal = session.terminal
  return {
    get busy() {
      return Boolean(session.active)
    },
    get closed() {
      return session.closed
    },
    write(data: string | Uint8Array) {
      const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data
      // Claude emits no Stop hook for user interrupts; close the owned turn explicitly.
      if (
        session.active?.submitted &&
        (bytes.includes(3) || (bytes.length === 1 && bytes[0] === 27))
      ) {
        session.active.events.push({ kind: 'aborted' })
        closeSession(session)
        return
      }
      terminal.write(data)
    },
    resize: terminal.resize,
    history: terminal.history,
    close: () => closeSession(session),
    subscribe(listener: Listener) {
      session.listeners.add(listener)
      return () => {
        session.listeners.delete(listener)
      }
    },
  }
}

export type NativeRuntimeDependencies = {
  startTerminal: typeof startNativeTerminal
  startBridge: typeof startNativeBridge
  adoptionTimeoutMs: number
  assertSubscriptionLogin: typeof assertSubscriptionLogin
}

const subscriptionError = () =>
  new Error(
    'Native Claude requires an authenticated Claude subscription. Sign in with claude auth login.',
  )

async function verifySubscription(
  check: typeof assertSubscriptionLogin,
  cwd: string,
  signal: AbortSignal,
) {
  let onAbort: () => void = () => {}
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(new Error('Subscription verification aborted'))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()
  })
  try {
    await Promise.race([Promise.resolve().then(() => check(cwd, signal)), cancelled])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

async function authorizeRun(
  options: LoopOptions,
  deps: NativeRuntimeDependencies,
  signal: AbortSignal,
) {
  const cwd = options.cwd ?? process.cwd()
  try {
    await verifySubscription(deps.assertSubscriptionLogin, cwd, signal)
    return !signal.aborted
  } catch {
    closeNativeAgent(cwd, options.agentId ?? '')
    if (signal.aborted) return false
    throw subscriptionError()
  }
}

async function adoptPrompt(session: NativeSession, prompt: string | undefined) {
  try {
    await verifySubscription(session.checkLogin, session.cwd, session.lifetime.signal)
  } catch {
    const error = subscriptionError()
    session.active?.events.push({ kind: 'error', error })
    closeSession(session)
    return { decision: 'block', reason: error.message }
  }
  if (session.closed) return { decision: 'block', reason: 'Native Claude session closed' }
  if (session.active) {
    if (session.active.submitted)
      return { decision: 'block', reason: 'Wait for the current AIDCrew turn to finish.' }
    session.active.submitted = true
    return
  }
  const dispatch = dispatchers.get(session.cwd)
  if (!dispatch || !prompt)
    return { decision: 'block', reason: 'The AIDCrew agent is no longer connected.' }
  await new Promise<void>((resolve, reject) => {
    const clear = () => {
      clearTimeout(timer)
      if (session.adoption === adoption) session.adoption = undefined
    }
    const adoption: Adoption = {
      resolve() {
        clear()
        resolve()
      },
      reject(error) {
        clear()
        reject(error)
      },
    }
    const timer = setTimeout(
      () =>
        adoption.reject(
          new Error(
            'AIDCrew did not accept the native prompt in time. Try again through the harness.',
          ),
        ),
      session.adoptionTimeoutMs,
    )
    timer.unref()
    session.adoption = adoption
    void dispatch(session.agentId, prompt).catch((error: unknown) => {
      adoption.reject(error instanceof Error ? error : new Error('Could not adopt native prompt'))
    })
  })
}

function receiveHook(session: NativeSession, event: BridgeHookEvent) {
  if (event.hook_event_name === 'UserPromptSubmit') return adoptPrompt(session, event.prompt)
  if (event.hook_event_name === 'Stop' && session.active?.submitted)
    session.active?.events.push({ kind: 'done', text: event.last_assistant_message ?? '' })
  if (event.hook_event_name === 'StopFailure')
    session.active?.events.push({
      kind: 'error',
      error: new Error(`Native Claude failed: ${event.error ?? 'unknown'}`),
    })
}

function launch(options: LoopOptions, active: ActiveRun, deps: NativeRuntimeDependencies) {
  const cwd = options.cwd ?? process.cwd()
  const agentId = options.agentId ?? ''
  const session: NativeSession = {
    cwd,
    agentId,
    model: nativeModel(options.model),
    yolo: options.yolo === true,
    adoptionTimeoutMs: deps.adoptionTimeoutMs,
    checkLogin: deps.assertSubscriptionLogin,
    lifetime: new AbortController(),
    active,
    adoption: undefined,
    terminal: undefined,
    bridge: undefined,
    listeners: new Set(),
    closed: false,
  }
  sessions.set(key(cwd, agentId), session)
  try {
    const bridge = deps.startBridge({
      getOptions: () => session.active?.options,
      onEvent: (event) => session.active?.events.push({ kind: 'event', event }),
      onHook: (event) => receiveHook(session, event),
    })
    session.bridge = bridge
    session.terminal = deps.startTerminal(
      {
        cwd,
        cols: 120,
        rows: 35,
        onData(data) {
          for (const listener of session.listeners) listener.data(data)
        },
        onExit(code) {
          for (const listener of session.listeners) listener.exit(code)
          closeSession(session)
        },
      },
      {
        command: nativeCommand({
          system: options.system,
          model: options.model,
          yolo: options.yolo === true,
          prompt: nativePrompt(options.messages),
          mcpConfig: bridge.mcpConfig,
          settings: bridge.settings,
        }),
      },
    )
    // Exit notification handles cleanup. The rejection remains visible to the active run.
    void session.terminal.exited.catch((error: unknown) => {
      session.active?.events.push({
        kind: 'error',
        error: error instanceof Error ? error : new Error('Native terminal failed'),
      })
      closeSession(session)
    })
    return session
  } catch (error) {
    closeSession(session)
    throw error
  }
}

async function* prepareOptions(
  input: LoopOptions,
  messages: Message[],
  signal: AbortSignal,
): AsyncGenerator<LoopEvent, LoopOptions> {
  const context = {
    agentId: input.agentId ?? '',
    model: input.model,
    lastUsage: { inputTokens: 0, outputTokens: 0 },
    turn: 1,
    signal,
  }
  const instructionsContext = {
    ...context,
    tools: input.tools.map((tool) => tool.name),
    cwd: input.cwd ?? process.cwd(),
  }
  let system = input.system
  for (const [index, hook] of (input.hooks ?? []).entries()) {
    let hookName: 'preTurn' | 'instructions' = 'preTurn'
    try {
      const updated = await hook.preTurn?.(messages, context)
      if (updated) messages.splice(0, messages.length, ...updated)
      hookName = 'instructions'
      const extra = await hook.instructions?.(instructionsContext)
      if (extra) system += `\n\n${extra}`
    } catch (error) {
      const plugin = input.hookNames?.[index]
      yield {
        type: 'hook_error',
        hook: hookName,
        message: errorMessage(error),
        ...(plugin ? { plugin } : {}),
      }
    }
  }
  return { ...input, system, messages }
}

function attachRun(options: LoopOptions, deps: NativeRuntimeDependencies) {
  const prompt = nativePrompt(options.messages)
  // Validate before creating or touching an interactive process.
  const pasted = pastePrompt(prompt)
  const existing = sessions.get(key(options.cwd ?? process.cwd(), options.agentId ?? ''))
  if (existing?.active) throw new Error('Native Claude agent is already processing a turn')
  if (existing && existing.yolo !== (options.yolo === true))
    throw new Error(
      'Native Claude permission mode changed. Restart the agent to apply the new mode.',
    )
  if (existing && existing.model !== nativeModel(options.model))
    throw new Error(
      'The harness model changed after native Claude started. Restore the launch model and use native /model, or restart the agent to apply the new model.',
    )
  const active: ActiveRun = { options, events: eventQueue(), submitted: false }
  const session = existing ?? launch(options, active, deps)
  if (existing) {
    session.active = active
    if (session.adoption) {
      active.submitted = true
      session.adoption.resolve()
      session.adoption = undefined
    } else session.terminal?.write(pasted)
  }
  return { session, active }
}

async function* consumeEvents(
  active: ActiveRun,
  signal: AbortSignal,
): AsyncGenerator<LoopEvent, string | undefined> {
  for (;;) {
    const event = await active.events.next()
    if (signal.aborted || event.kind === 'aborted') return undefined
    if (event.kind === 'error') throw event.error
    if (event.kind === 'done') return event.text
    yield event.event
  }
}

export function createNativeProvider(dependencies: Partial<NativeRuntimeDependencies> = {}) {
  const deps = {
    startTerminal: startNativeTerminal,
    startBridge: startNativeBridge,
    adoptionTimeoutMs: 30_000,
    assertSubscriptionLogin,
    ...dependencies,
  }
  return {
    id: 'claude-code',
    send(): never {
      throw new Error('Native Claude requires the interactive agent runtime')
    },
    async *run(input: LoopOptions): AsyncGenerator<LoopEvent, LoopResult> {
      const messages: Message[] = [...input.messages]
      const usage = { inputTokens: 0, outputTokens: 0, unstatedTurns: 1 }
      const signal = input.signal ?? new AbortController().signal
      const finish = (stopReason: LoopResult['stopReason']): LoopResult => ({
        messages,
        stopReason,
        usage,
        turns: 1,
      })
      if (signal.aborted) return finish('aborted')
      if (!(await authorizeRun(input, deps, signal))) return finish('aborted')
      const options = yield* prepareOptions(input, messages, signal)
      const { session, active } = attachRun(options, deps)
      const abort = () => closeSession(session)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
      let completed = false
      try {
        yield { type: 'turn_start', turn: 1 }
        const text = yield* consumeEvents(active, signal)
        if (text === undefined) return finish('aborted')
        completed = true
        const turn = {
          content: [{ type: 'text' as const, text }],
          stopReason: 'end_turn' as const,
          usage,
        }
        yield { type: 'assistant_turn', turn }
        messages.push({ role: 'assistant', content: turn.content })
        return finish('end_turn')
      } finally {
        signal.removeEventListener('abort', abort)
        if (!completed) closeSession(session)
        session.active = undefined
      }
    },
  } satisfies Provider & { run(input: LoopOptions): AsyncGenerator<LoopEvent, LoopResult> }
}
