import type {
  CanonicalRequest,
  ContentBlock,
  Message,
  Provider,
  StopReason,
  StreamDelta,
  ToolDefinition,
} from '@aidcrew/core'

const OPEN = '<tool_call>'
const CLOSE = '</tool_call>'
const RESULT = 'tool_result'

/**
 * Gives tool calling to a model that does not have it.
 *
 * Plenty of capable models either lack native tool calling or implement it
 * badly — the usual case behind a gateway, and on locally served weights. The
 * technique is old and reliable: describe the tools in the system prompt, ask
 * for calls in a fixed textual form, and parse them back out of the stream.
 *
 * It lives here rather than in the core so the core keeps knowing nothing
 * about wire formats: a provider plugin wraps itself in this when its model
 * needs it, and nothing else changes anywhere.
 */
export function withPromptedTools(provider: Provider): Provider {
  // Counted across turns, never from zero again. Each turn minted
  // `…-prompted-0` for its first call, so the second turn's call carried the
  // first turn's id and its result was filed against the wrong call.
  let minted = 0
  const nextId = (): string => `${provider.id}-prompted-${minted++}`

  return {
    id: provider.id,

    async *send(request: CanonicalRequest, signal: AbortSignal): AsyncIterable<StreamDelta> {
      if (request.tools.length === 0) {
        yield* provider.send(request, signal)
        return
      }

      const names = namesOf(request.messages)
      const rewritten: CanonicalRequest = {
        ...request,
        system: `${request.system}\n\n${renderTools(request.tools)}`,
        messages: request.messages.map((message) => asText(message, names)),
        tools: [],
      }

      yield* extractCalls(provider.send(rewritten, signal), nextId)
    },
  }
}

/**
 * One earlier message, as this model can read it.
 *
 * At first only the prompt and the tool list were rewritten. The turns before
 * still carried the model's calls as tool_use blocks and their answers as
 * tool_result blocks, and the dialect rendered those the only way it knows:
 * native tool calls, and a `tool` role for the results. So a model that cannot
 * use tools was shown its own call in a shape it had never seen, and the
 * answer in a role a strict server rejects outright when no tools were
 * declared. Here both become the text the prompt teaches, so the second turn
 * reads to the model exactly like the first.
 */
function asText(message: Message, names: Map<string, string>): Message {
  const hasTools = message.content.some(
    (block) => block.type === 'tool_use' || block.type === 'tool_result',
  )
  if (!hasTools) return message

  const content: ContentBlock[] = []
  for (const block of message.content) {
    if (block.type === 'tool_use') {
      const call = JSON.stringify({ name: block.name, arguments: block.input })
      appendText(content, `${OPEN}${call}${CLOSE}`)
    } else if (block.type === 'tool_result') {
      appendText(content, renderResult(block, names.get(block.toolUseId)))
    } else if (block.type === 'text') {
      appendText(content, block.text)
    } else {
      content.push(block)
    }
  }
  return { ...message, content }
}

/**
 * Adds text onto a text block already at the end, rather than beside it.
 *
 * Most dialects join an assistant's text blocks with nothing between them, so
 * kept apart the prose and the call after it would arrive as one run-on line.
 */
function appendText(content: ContentBlock[], text: string): void {
  const last = content.at(-1)
  if (last?.type === 'text') {
    content[content.length - 1] = { type: 'text', text: `${last.text}\n${text}` }
  } else {
    content.push({ type: 'text', text })
  }
}

function renderResult(
  block: Extract<ContentBlock, { type: 'tool_result' }>,
  name: string | undefined,
): string {
  const named = name === undefined ? '' : ` name="${name}"`
  const failed = block.isError ? ' error="true"' : ''
  return `<${RESULT}${named}${failed}>${block.content}</${RESULT}>`
}

/** Which tool each earlier call was for, by id: a result names only the id. */
function namesOf(messages: Message[]): Map<string, string> {
  const names = new Map<string, string>()
  for (const message of messages) {
    for (const block of message.content) {
      if (block.type === 'tool_use') names.set(block.id, block.name)
    }
  }
  return names
}

function renderTools(tools: ToolDefinition[]): string {
  const described = tools
    .map(
      (tool) =>
        `${tool.name}: ${tool.description}\n  arguments: ${JSON.stringify(tool.inputSchema)}`,
    )
    .join('\n\n')

  return `You have tools. To use one, write exactly this and nothing else after it:

${OPEN}{"name": "<tool>", "arguments": {...}}${CLOSE}

Write one call at a time and stop. The result comes back in the next user message as
<${RESULT} name="<tool>">...</${RESULT}>, with error="true" on it when the tool failed,
and then you continue.
Write the block verbatim — no code fences, no commentary inside it.

Available tools:

${described}`
}

/**
 * Rewrites a text stream into tool-call deltas.
 *
 * Text is held back whenever its tail could still turn out to be the start of
 * a tag, so a call split across tokens is never leaked to the user as visible
 * prose — the failure everyone hits when they build this quickly.
 */
async function* extractCalls(
  source: AsyncIterable<StreamDelta>,
  nextId: () => string,
): AsyncIterable<StreamDelta> {
  let buffer = ''
  let calls = 0

  for await (const delta of source) {
    if (delta.type !== 'text_delta') {
      // A done delta may need its stop reason corrected once calls were found.
      if (delta.type === 'done') {
        yield* flush(buffer)
        buffer = ''
        yield { ...delta, stopReason: correctedStop(delta.stopReason, calls) }
        continue
      }
      yield delta
      continue
    }

    buffer += delta.text
    const drained = yield* drainCalls(buffer, nextId, calls)
    buffer = drained.rest
    calls = drained.calls
    buffer = yield* releaseSafeText(buffer)
  }

  yield* flush(buffer)
}

/** Emits every complete call in the buffer, returning what is left of it. */
async function* drainCalls(
  buffer: string,
  nextId: () => string,
  calls: number,
): AsyncGenerator<StreamDelta, { rest: string; calls: number }> {
  let rest = buffer
  let found = calls

  for (;;) {
    const open = rest.indexOf(OPEN)
    if (open === -1) break
    const close = rest.indexOf(CLOSE, open)
    if (close === -1) break

    const before = rest.slice(0, open)
    if (before !== '') yield { type: 'text_delta', text: before }

    const body = rest.slice(open + OPEN.length, close)
    rest = rest.slice(close + CLOSE.length)

    const emitted = yield* emitCall(body, nextId)
    if (emitted) found += 1
    else yield { type: 'text_delta', text: `${OPEN}${body}${CLOSE}` }
  }

  return { rest, calls: found }
}

/**
 * Emits the part of the buffer that can no longer turn out to be a call, and
 * returns what must still be held back.
 */
async function* releaseSafeText(buffer: string): AsyncGenerator<StreamDelta, string> {
  // An opening tag with no closing tag yet: everything from it onwards is a
  // call in progress and must not be shown as prose.
  const pending = buffer.indexOf(OPEN)
  if (pending !== -1) {
    if (pending > 0) yield { type: 'text_delta', text: buffer.slice(0, pending) }
    return buffer.slice(pending)
  }

  const safe = buffer.length - longestTagPrefix(buffer)
  if (safe <= 0) return buffer
  yield { type: 'text_delta', text: buffer.slice(0, safe) }
  return buffer.slice(safe)
}

async function* flush(buffer: string): AsyncIterable<StreamDelta> {
  if (buffer !== '') yield { type: 'text_delta', text: buffer }
}

/**
 * Emits one parsed call, or returns false if the block was not usable.
 *
 * A malformed block becomes visible text rather than a guess: inventing
 * arguments for a half-written call would hand made-up input to a tool that
 * can write files.
 */
async function* emitCall(body: string, nextId: () => string): AsyncGenerator<StreamDelta, boolean> {
  let parsed: { name?: unknown; arguments?: unknown }
  try {
    parsed = JSON.parse(body.trim()) as { name?: unknown; arguments?: unknown }
  } catch {
    return false
  }

  if (typeof parsed.name !== 'string' || parsed.name === '') return false

  const id = nextId()
  yield { type: 'tool_use_start', id, name: parsed.name }
  yield {
    type: 'tool_use_delta',
    id,
    partialInput: JSON.stringify(parsed.arguments ?? {}),
  }
  yield { type: 'tool_use_end', id }
  return true
}

/** Length of the longest suffix of `text` that is a prefix of the open tag. */
function longestTagPrefix(text: string): number {
  const max = Math.min(text.length, OPEN.length - 1)
  for (let length = max; length > 0; length--) {
    if (OPEN.startsWith(text.slice(text.length - length))) return length
  }
  return 0
}

/** A model that thinks it only wrote prose reports end_turn; it asked for a tool. */
function correctedStop(stopReason: StopReason, calls: number): StopReason {
  return calls > 0 && stopReason === 'end_turn' ? 'tool_use' : stopReason
}
