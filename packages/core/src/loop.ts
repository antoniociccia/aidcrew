import { accumulate } from './accumulator.ts'
import type { HookName, Hooks, ToolCallInfo, TurnContext } from './plugins/types.ts'
import type {
  AssistantTurn,
  CanonicalRequest,
  ContentBlock,
  Message,
  StopReason,
  StreamDelta,
  Usage,
} from './types.ts'

export type ToolContext = {
  signal: AbortSignal
  cwd: string
  /**
   * Who is making the call.
   *
   * A hook guarding tool calls has to know: with a team running, "something
   * wants to run a command" is not a question anyone can answer, and the
   * approval has to appear next to the agent that asked for it. Empty for a
   * loop run outside a team.
   */
  agentId: string
}

export type ToolOutput = {
  content: string
  isError?: boolean
}

export type Tool = {
  name: string
  description: string
  /**
   * Whether this tool changes nothing.
   *
   * Declared because the loop cannot tell: a turn that asks for four files
   * waited for each in turn, so four reads took four times as long as one,
   * and nothing about reading a file needs to happen after reading another.
   * Absent means it might change something, which is the answer that costs
   * time rather than correctness — a tool that writes and forgets to say so
   * is simply as slow as it was.
   */
  reads?: boolean
  /** JSON Schema for the arguments. */
  inputSchema: Record<string, unknown>
  /**
   * Arguments arrive as `unknown` on purpose: they were written by a model and
   * are hostile until validated. Every tool validates its own input.
   */
  execute(input: unknown, context: ToolContext): Promise<ToolOutput>
}

export type Provider = {
  id: string
  send(request: CanonicalRequest, signal: AbortSignal): AsyncIterable<StreamDelta>
}

export type LoopEvent =
  | { type: 'turn_start'; turn: number }
  | { type: 'delta'; delta: StreamDelta }
  | { type: 'assistant_turn'; turn: AssistantTurn }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; output: ToolOutput; durationMs: number }
  /** A plugin hook threw. Surfaced rather than swallowed, so a misbehaving
   *  plugin is visible instead of quietly changing what the agent does. */
  | { type: 'hook_error'; hook: HookName; message: string; plugin?: string }

/** Why the loop gave control back, including the reasons the model never sends. */
export type LoopStopReason = StopReason | 'max_turns' | 'aborted'

export type LoopResult = {
  messages: Message[]
  stopReason: LoopStopReason
  usage: Usage
  turns: number
}

export type LoopOptions = {
  provider: Provider
  model: string
  system: string
  tools: Tool[]
  messages: Message[]
  maxTurns?: number
  maxTokens?: number
  temperature?: number
  cwd?: string
  signal?: AbortSignal
  /** Who this loop is running as, carried through to tools and hooks. */
  agentId?: string
  /** Plugin hooks, applied in order. */
  hooks?: Hooks[]
  /**
   * Which plugin each set of hooks came from, in the same order.
   *
   * So that "a hook threw" can say whose. With ten plugins installed, the
   * name of the hook narrows it to ten possibilities, which is no narrowing
   * at all — and a plugin that misbehaves is one somebody can remove.
   */
  hookNames?: string[]
}

const DEFAULT_MAX_TURNS = 50

/**
 * How long one answer may be.
 *
 * It was 8192, with nothing written beside it, and it was not a decision — it
 * is the shape of an API that made the field required, kept as a default
 * nobody chose. What it did was cut a turn in half: an agent asked to write
 * three files got through two, overran partway into the third `write`, and the
 * call arrived with an empty input and never ran. That is not a rare case, it
 * is what writing code looks like.
 *
 * It is not the spend control either. That is the governor's, whose budgets
 * say so in as many words — a decision about money. This is only how much
 * room one answer gets, and an unused cap costs nothing.
 *
 * A number rather than the model's own ceiling because the provider contract
 * does not carry one yet. Set `maxTokens` for a service that will not accept
 * this much; that is the escape hatch which makes the larger default safe, and
 * a provider declaring its own limit is the version of this that stops needing
 * one.
 */
const DEFAULT_MAX_TOKENS = 32_768

/**
 * The whole agent loop: ask the model, run whatever tools it asked for, hand
 * the results back, repeat until it stops asking.
 *
 * Everything else an agent might want — permission prompts, retries, context
 * compaction, sub-agents — is a hook or a plugin around this, never a branch
 * inside it. That is what keeps the loop small enough to read in one sitting.
 */
export async function* runAgentLoop(options: LoopOptions): AsyncGenerator<LoopEvent, LoopResult> {
  const maxTurns = options.maxTurns ?? DEFAULT_MAX_TURNS
  const signal = options.signal ?? new AbortController().signal
  const context: ToolContext = {
    signal,
    cwd: options.cwd ?? process.cwd(),
    agentId: options.agentId ?? '',
  }
  const byName = new Map(options.tools.map((tool) => [tool.name, tool]))

  const messages = [...options.messages]
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let lastTurn: Usage = { inputTokens: 0, outputTokens: 0 }
  let turns = 0
  const hooks = options.hooks ?? []

  const finish = (stopReason: LoopStopReason): LoopResult => ({
    messages,
    stopReason,
    usage,
    turns,
  })

  for (;;) {
    if (signal.aborted) return finish('aborted')
    if (turns >= maxTurns) return finish('max_turns')

    turns += 1
    yield { type: 'turn_start', turn: turns }

    // Hooks get to rewrite the conversation before it is sent. This is where a
    // history that no longer fits gets shortened; the loop itself has no
    // opinion about when that is or what it should be replaced with.
    yield* applyPreTurn(messages, hooks, {
      agentId: context.agentId,
      model: options.model,
      lastUsage: lastTurn,
      turn: turns,
      signal,
    })

    // Deltas are buffered so they can be both streamed to the caller and
    // replayed into the accumulator. One turn of deltas is small; a shared
    // iterator would have to be teed, which is more machinery than it saves.
    const deltas: StreamDelta[] = []
    for await (const delta of options.provider.send(buildRequest(options, messages), signal)) {
      deltas.push(delta)
      yield { type: 'delta', delta }
    }

    const turn = await accumulate(replay(deltas))
    messages.push({ role: 'assistant', content: turn.content })
    accumulateUsage(usage, turn.usage)
    lastTurn = turn.usage
    yield { type: 'assistant_turn', turn }

    if (turn.stopReason !== 'tool_use') return finish(turn.stopReason)

    const calls = turn.content.filter((block) => block.type === 'tool_use')
    messages.push({
      role: 'user',
      content: yield* executeCalls(calls, byName, context, hooks, options.hookNames ?? []),
    })
  }
}

function buildRequest(options: LoopOptions, messages: Message[]): CanonicalRequest {
  return {
    model: options.model,
    system: options.system,
    messages,
    tools: options.tools.map(({ name, description, inputSchema }) => ({
      name,
      description,
      inputSchema,
    })),
    maxTokens: options.maxTokens ?? DEFAULT_MAX_TOKENS,
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
  }
}

/**
 * Runs one turn's tool calls and returns the result blocks, in order.
 *
 * Anything that might change something runs on its own, in the order it was
 * asked for: two such calls in one turn may touch the same file, and running
 * those concurrently makes the outcome depend on whichever finishes first.
 *
 * A run of calls that only read goes at once. Reading four files took four
 * times as long as reading one, for nothing — and a turn that asks for
 * everything it needs at the same time is the thing the system prompt asks
 * for, so it should not be the slow way to work.
 *
 * The results come back in the order they were asked for whatever order they
 * finished in: a model matches a result to a call by its id, and one that
 * arrives out of order is a conversation providers reject.
 */
async function* executeCalls(
  calls: Extract<ContentBlock, { type: 'tool_use' }>[],
  byName: Map<string, Tool>,
  context: ToolContext,
  hooks: Hooks[],
  names: string[] = [],
): AsyncGenerator<LoopEvent, ContentBlock[]> {
  const results: ContentBlock[] = []

  for (const batch of batched(calls, byName)) {
    // Every start first, because they did all start: a turn that asked for
    // four files at once should look like one, not like four in a row.
    for (const call of batch) {
      yield { type: 'tool_start', id: call.id, name: call.name, input: call.input }
    }

    if (batch.length === 1 && batch[0]) {
      const call = batch[0]
      const info: ToolCallInfo = { id: call.id, name: call.name, input: call.input }
      const startedAt = performance.now()
      const output = yield* guardedRun(info, byName.get(call.name), context, hooks, names)
      const durationMs = performance.now() - startedAt

      yield { type: 'tool_end', id: call.id, name: call.name, output, durationMs }
      results.push(resultOf(call.id, output))
      continue
    }

    // A batch runs concurrently, and a generator cannot yield from inside a
    // Promise.all — which is why these calls used to skip the hooks entirely.
    // Skipping them was wrong in both directions: postToolCall exists for
    // redaction and audit, which are read-side by definition, and a read-side
    // preToolCall is how anybody writes a path allowlist. So the events are
    // collected while the batch runs and yielded once it is done: the reads
    // still go at once, and every one of them is still seen.
    const startedAt = performance.now()
    const collected: LoopEvent[] = []
    const outputs = await Promise.all(
      batch.map(async (call) => {
        const info: ToolCallInfo = { id: call.id, name: call.name, input: call.input }
        const veto = await collectPreHooks(info, context, hooks, names, collected)
        if (veto) return veto

        const output = await runTool(byName.get(call.name), call.name, call.input, context)
        return await collectPostHooks(info, output, context, hooks, names, collected)
      }),
    )
    const durationMs = performance.now() - startedAt

    for (const event of collected) yield event

    for (const [at, call] of batch.entries()) {
      const output = outputs[at] ?? { content: `no such tool: ${call.name}`, isError: true }
      yield { type: 'tool_end', id: call.id, name: call.name, output, durationMs }
      results.push(resultOf(call.id, output))
    }
  }

  return results
}

/**
 * Lets hooks rewrite the conversation before it is sent.
 *
 * Applied in order, each seeing what the one before produced, so a compaction
 * and an audit hook compose rather than collide. A hook that returns nothing
 * has decided to leave the conversation alone.
 *
 * A hook that throws is reported and ignored, and the conversation stands as
 * it was. Failing open is right here and wrong for a tool call — the opposite
 * of `preToolCall`, which denies on failure — because the worst a broken
 * compaction does is leave the history long, while the worst a broken
 * approval does is run the command.
 */
async function* applyPreTurn(
  messages: Message[],
  hooks: Hooks[],
  context: TurnContext,
): AsyncGenerator<LoopEvent, void> {
  for (const hook of hooks) {
    if (!hook.preTurn) continue
    try {
      const replaced = await hook.preTurn(messages, context)
      if (!replaced) continue
      messages.length = 0
      messages.push(...replaced)
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      yield { type: 'hook_error', hook: 'preTurn', message }
    }
  }
}

/**
 * Runs one tool call through the hooks that surround it.
 *
 * The two failure modes are deliberately opposite. A `preToolCall` hook that
 * throws denies the call: a policy that crashed approved nothing, and reading
 * its failure as consent is exactly how a permission system betrays you. A
 * `postToolCall` hook that throws is ignored and the original result stands,
 * because the work is already done and discarding it helps no one.
 */
async function* guardedRun(
  call: ToolCallInfo,
  tool: Tool | undefined,
  context: ToolContext,
  hooks: Hooks[],
  names: string[] = [],
): AsyncGenerator<LoopEvent, ToolOutput> {
  const veto = yield* applyPreHooks(call, context, hooks, names)
  if (veto) return veto

  const output = await runTool(tool, call.name, call.input, context)
  return yield* applyPostHooks(call, output, context, hooks, names)
}

/** Returns the output that cancels the call, or undefined to let it proceed. */
async function* applyPreHooks(
  call: ToolCallInfo,
  context: ToolContext,
  hooks: Hooks[],
  names: string[] = [],
): AsyncGenerator<LoopEvent, ToolOutput | undefined> {
  const collected: LoopEvent[] = []
  const veto = await collectPreHooks(call, context, hooks, names, collected)
  for (const event of collected) yield event
  return veto
}

/**
 * The same work, with the events put in a list instead of yielded.
 *
 * This is the implementation and the generator above is the wrapper, rather
 * than the other way round, because a batch of concurrent calls cannot yield
 * from inside the Promise.all that runs it — and two copies of a decision
 * about whether a tool may run is one copy too many.
 */
async function collectPreHooks(
  call: ToolCallInfo,
  context: ToolContext,
  hooks: Hooks[],
  names: string[],
  into: LoopEvent[],
): Promise<ToolOutput | undefined> {
  for (const [at, hook] of hooks.entries()) {
    if (!hook.preToolCall) continue
    try {
      // Raced against the turn's own signal. This is somebody else's code
      // awaited with no timeout, and the loop only tests the signal at the
      // top of a turn — so a hook waiting on something that never happens (a
      // prompt on a screen that has gone, a request with no timeout) wedged
      // the agent permanently, and Esc did not get you out.
      const veto = await untilAborted(hook.preToolCall(call, context), context.signal)
      if (veto === ABORTED) {
        return { content: `tool ${call.name} was not run: the turn was cancelled`, isError: true }
      }
      if (veto) return veto
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause)
      into.push({
        type: 'hook_error',
        hook: 'preToolCall',
        message,
        ...(names[at] ? { plugin: names[at] } : {}),
      })
      return { content: `tool ${call.name} was not approved: ${message}`, isError: true }
    }
  }
  return undefined
}

/** What a raced promise resolves to when the signal won. */
const ABORTED = Symbol('aborted')

/**
 * A promise, or the abort — whichever happens first.
 *
 * Nothing is cancelled by this: the hook keeps running, unaware. What changes
 * is that the loop stops waiting on it, which is the difference between an
 * agent you can interrupt and one you have to kill the terminal to escape.
 */
async function untilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T | typeof ABORTED> {
  if (signal.aborted) return ABORTED
  return await Promise.race([
    work,
    new Promise<typeof ABORTED>((resolve) => {
      signal.addEventListener('abort', () => resolve(ABORTED), { once: true })
    }),
  ])
}

async function* applyPostHooks(
  call: ToolCallInfo,
  output: ToolOutput,
  context: ToolContext,
  hooks: Hooks[],
  names: string[] = [],
): AsyncGenerator<LoopEvent, ToolOutput> {
  const collected: LoopEvent[] = []
  const result = await collectPostHooks(call, output, context, hooks, names, collected)
  for (const event of collected) yield event
  return result
}

async function collectPostHooks(
  call: ToolCallInfo,
  output: ToolOutput,
  context: ToolContext,
  hooks: Hooks[],
  names: string[],
  into: LoopEvent[],
): Promise<ToolOutput> {
  let current = output
  for (const [at, hook] of hooks.entries()) {
    if (!hook.postToolCall) continue
    try {
      const replaced = await hook.postToolCall(call, current, context)
      if (replaced) current = replaced
    } catch (cause) {
      into.push({
        type: 'hook_error',
        hook: 'postToolCall',
        message: cause instanceof Error ? cause.message : String(cause),
        // Named like every other hook failure. Without this the one hook that
        // can quietly rewrite what the model reads was the one whose failures
        // did not say whose they were.
        ...(names[at] ? { plugin: names[at] } : {}),
      })
    }
  }
  return current
}

/**
 * A tool that is missing or that throws is reported back to the model as a
 * failed result rather than raised: the model can read the message and try
 * something else, which is almost always better than ending the session.
 */
async function runTool(
  tool: Tool | undefined,
  name: string,
  input: unknown,
  context: ToolContext,
): Promise<ToolOutput> {
  if (!tool) {
    return { content: `unknown tool: ${name}`, isError: true }
  }
  try {
    return await tool.execute(input, context)
  } catch (cause) {
    const message = cause instanceof Error ? cause.message : String(cause)
    return { content: `tool ${name} failed: ${message}`, isError: true }
  }
}

async function* replay(deltas: StreamDelta[]): AsyncIterable<StreamDelta> {
  for (const delta of deltas) yield delta
}

/**
 * Adds one request's usage to a running total, in place.
 *
 * Exported for the host, which keeps its own copy of this sum as the
 * `assistant_turn` events go by. The loop's total lives in the result it
 * returns, and a turn that throws — a 5xx on the fourth request, the transport
 * aborting under the escape key — returns nothing: three requests of a hundred
 * thousand tokens each were then recorded as costing nothing, and an agent
 * well past its budget was allowed to carry on.
 *
 * Not `addUsage` from the canonical types, which also counts the turns that
 * said nothing about money. That count belongs to an instruction, and the
 * requests inside one are not each a silent turn.
 */
export function accumulateUsage(total: Usage, turn: Usage): void {
  total.inputTokens += turn.inputTokens
  total.outputTokens += turn.outputTokens
  if (turn.cacheReadTokens !== undefined) {
    total.cacheReadTokens = (total.cacheReadTokens ?? 0) + turn.cacheReadTokens
  }
  if (turn.cacheWriteTokens !== undefined) {
    total.cacheWriteTokens = (total.cacheWriteTokens ?? 0) + turn.cacheWriteTokens
  }
  // Kept strictly apart, and never folded into one another. They are both
  // real money and not the same money, and a total that has mixed them can
  // no longer say how much of it was actually charged to anything.
  if (turn.chargedUsd !== undefined) {
    total.chargedUsd = (total.chargedUsd ?? 0) + turn.chargedUsd
  }
  if (turn.listedUsd !== undefined) {
    total.listedUsd = (total.listedUsd ?? 0) + turn.listedUsd
  }
}

/** One tool result block, which is the same shape wherever it came from. */
function resultOf(id: string, output: ToolOutput): ContentBlock {
  return {
    type: 'tool_result',
    toolUseId: id,
    content: output.content,
    isError: output.isError ?? false,
  }
}

/**
 * The calls grouped into what can go at once.
 *
 * A run of tools that only read becomes one batch; anything else is a batch of
 * its own, so it keeps its place in the order and nothing runs beside it.
 */
function batched(
  calls: Extract<ContentBlock, { type: 'tool_use' }>[],
  byName: Map<string, Tool>,
): Extract<ContentBlock, { type: 'tool_use' }>[][] {
  const batches: Extract<ContentBlock, { type: 'tool_use' }>[][] = []
  for (const call of calls) {
    const reads = byName.get(call.name)?.reads === true
    const last = batches.at(-1)
    if (reads && last && byName.get(last[0]?.name ?? '')?.reads === true) last.push(call)
    else batches.push([call])
  }
  return batches
}
