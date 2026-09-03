import type {
  CanonicalRequest,
  ContentBlock,
  Message,
  StopReason,
  StreamDelta,
  Usage,
} from '@aidcrew/core'
import { ProviderProtocolError, ProviderResponseError } from '@aidcrew/core'
import { parseSse } from '@aidcrew/plugin-sdk'
import { notAStream, remembering } from './body.ts'

/**
 * The Responses API — OpenAI's second dialect, and the one some models are
 * served on exclusively.
 *
 * On OpenCode Go, `muse-spark-1.2-contributor`, `grok-4.6` and `gpt-5.6-luna`
 * answer here and nowhere else: asking for them at /chat/completions returns
 * "Model ... is not supported", which reads like the model does not exist
 * rather than like the address is wrong.
 *
 * The shape differs from chat completions in three ways that matter: messages
 * are `input` with typed content parts, tools are flat rather than nested
 * under `function`, and the stream is a sequence of named events instead of
 * deltas on a choice.
 */

type ResponsesContent =
  | { type: 'input_text'; text: string }
  | { type: 'output_text'; text: string }
  | { type: 'input_image'; image_url: string }

type ResponsesItem =
  | { type: 'message'; role: 'user' | 'assistant'; content: ResponsesContent[] }
  | { type: 'function_call'; call_id: string; name: string; arguments: string }
  | { type: 'function_call_output'; call_id: string; output: string }

export type ResponsesBody = {
  model: string
  input: ResponsesItem[]
  stream: true
  max_output_tokens: number
  instructions?: string
  tools?: {
    type: 'function'
    name: string
    description: string
    parameters: Record<string, unknown>
  }[]
  temperature?: number
}

export function buildResponsesBody(request: CanonicalRequest): ResponsesBody {
  return {
    model: request.model,
    // The system prompt is `instructions` here, not a message.
    ...(request.system === '' ? {} : { instructions: request.system }),
    input: request.messages.flatMap(translate),
    stream: true,
    max_output_tokens: request.maxTokens,
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function' as const,
            name: tool.name,
            description: tool.description,
            parameters: tool.inputSchema,
          })),
        }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  }
}

function translate(message: Message): ResponsesItem[] {
  const items: ResponsesItem[] = []
  const text: ResponsesContent[] = []

  for (const block of message.content) {
    if (block.type === 'text' && block.text !== '') {
      text.push({
        type: message.role === 'assistant' ? 'output_text' : 'input_text',
        text: block.text,
      })
    }
    if (block.type === 'image') {
      // Sent as a data URL: an agent's pictures are pasted, not published, so
      // there is no address to hand over.
      text.push({ type: 'input_image', image_url: `data:${block.mediaType};base64,${block.data}` })
    }
    if (block.type === 'tool_use') {
      items.push({
        type: 'function_call',
        call_id: block.id,
        name: block.name,
        arguments: JSON.stringify(block.input),
      })
    }
    if (block.type === 'tool_result') {
      items.push({ type: 'function_call_output', call_id: block.toolUseId, output: block.content })
    }
    // Thinking is dropped: replaying it is rejected and it is not conversation.
  }

  if (text.length > 0) {
    items.unshift({
      type: 'message',
      role: message.role === 'assistant' ? 'assistant' : 'user',
      content: text,
    })
  }

  return items
}

type Failure = {
  message?: string | undefined
  type?: string | undefined
  code?: string | undefined
}

type Event = {
  type?: string
  delta?: string
  item?: { type?: string; call_id?: string; id?: string; name?: string }
  /** Present on the argument deltas, and never on the item events. */
  item_id?: string
  /**
   * OpenAI's own `error` event puts these at the top, next to `type` — not
   * under an `error` key, which is where a gateway that wraps another
   * service's refusal puts them. Both shapes arrive in practice.
   */
  code?: string
  message?: string
  response?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      /** Where the service says how much of the prompt it had already. */
      input_tokens_details?: { cached_tokens?: number }
    }
    status?: string
    incomplete_details?: { reason?: string }
    /** Filled in on `response.failed`, the third place an error can sit. */
    error?: Failure
  }
  error?: Failure
}

const RETRYABLE = new Set(['rate_limit_exceeded', 'server_error', 'overloaded'])

/**
 * Raises whichever of the three error shapes the event carries.
 *
 * Only the first was read once, and the other two are the ones OpenAI itself
 * sends: an `error` event with `code` and `message` at the top, and a
 * `response.failed` with them nested under `response.error`. Unknown events
 * are not our business, so both fell through — and a rate limit or a rejected
 * prompt reached the user as an empty turn that cost nothing, which reads as
 * the model choosing to say nothing.
 */
function raiseReportedError(event: Event, providerId: string): void {
  const failure: Failure | undefined =
    event.error ??
    (event.type === 'error' ? { message: event.message, code: event.code } : undefined) ??
    (event.type === 'response.failed' ? (event.response?.error ?? {}) : undefined)
  if (!failure) return

  throw new ProviderResponseError(
    failure.message ?? 'the provider reported an error',
    providerId,
    RETRYABLE.has(failure.code ?? failure.type ?? ''),
  )
}

/**
 * What the stream has told us so far.
 *
 * Only the tool calls need remembering: a call is announced, its arguments
 * arrive in pieces addressed to it, and it is closed, so the pieces cannot be
 * understood one at a time.
 */
type Progress = {
  /**
   * Call ids, keyed by the *item* id.
   *
   * A tool call here has two identities: `item.id` ("fc_…"), which the
   * argument deltas are addressed to, and `item.call_id` ("call_…"), which the
   * result has to be sent back under. Keying by the wrong one loses every
   * argument and the tool is called with nothing — which is how it fails, so
   * this indirection earns its keep.
   */
  openCalls: Map<string, string>
  usage: Usage
  stopReason: StopReason
  sawToolCall: boolean
}

export async function* parseResponsesStream(
  body: AsyncIterable<Uint8Array>,
  providerId: string,
): AsyncIterable<StreamDelta> {
  const progress: Progress = {
    openCalls: new Map(),
    usage: { inputTokens: 0, outputTokens: 0 },
    stopReason: 'end_turn',
    sawToolCall: false,
  }

  const seen = remembering(body)
  let events = 0

  for await (const raw of parseSse(seen.bytes)) {
    events++
    if (raw === '[DONE]') break
    const event = parse(raw, providerId)
    raiseReportedError(event, providerId)
    yield* interpret(event, progress, providerId)
  }

  // No events at all is a body that was never a stream — a gateway that
  // answers 200 with its refusal in the body — and the refusal is what the
  // caller needs to see, not an empty turn that cost nothing.
  if (events === 0) throw notAStream(seen.text(), providerId)

  // A stream cut short can leave a call open. Closing it here lets the caller
  // decide what to do with half a call, rather than waiting for an end that
  // is not coming.
  for (const id of progress.openCalls.values()) yield { type: 'tool_use_end', id }

  yield {
    type: 'done',
    stopReason:
      progress.stopReason === 'end_turn' && progress.sawToolCall ? 'tool_use' : progress.stopReason,
    usage: progress.usage,
  }
}

/** One event, as canonical deltas. Unknown events are simply not our business. */
function* interpret(event: Event, progress: Progress, providerId: string): Generator<StreamDelta> {
  switch (event.type) {
    case 'response.output_text.delta':
      if (event.delta) yield { type: 'text_delta', text: event.delta }
      return

    case 'response.reasoning_summary_text.delta':
    case 'response.reasoning_text.delta':
      if (event.delta) yield { type: 'thinking_delta', text: event.delta }
      return

    case 'response.output_item.added':
      yield* openCall(event, progress, providerId)
      return

    case 'response.function_call_arguments.delta': {
      const id = progress.openCalls.get(event.item_id ?? '')
      if (id && event.delta) yield { type: 'tool_use_delta', id, partialInput: event.delta }
      return
    }

    case 'response.output_item.done': {
      const itemId = event.item?.id ?? event.item_id ?? ''
      const id = progress.openCalls.get(itemId)
      if (id) {
        progress.openCalls.delete(itemId)
        yield { type: 'tool_use_end', id }
      }
      return
    }

    case 'response.completed':
    case 'response.incomplete':
      absorb(event, progress)
      return

    default:
      return
  }
}

/** An item is opened for reasoning and messages too; only calls concern us. */
function* openCall(event: Event, progress: Progress, providerId: string): Generator<StreamDelta> {
  if (event.item?.type !== 'function_call') return

  const itemId = event.item.id ?? event.item_id
  const callId = event.item.call_id ?? itemId
  if (!itemId || !callId) {
    throw new ProviderProtocolError('function call arrived without an id', { provider: providerId })
  }

  progress.openCalls.set(itemId, callId)
  progress.sawToolCall = true
  yield { type: 'tool_use_start', id: callId, name: event.item.name ?? '' }
}

/**
 * Why a response stopped short, in the canonical vocabulary.
 *
 * A filtered answer has to come out as a refusal and not a clean end: the
 * service would not say it, and an agent told the turn ended normally asks
 * the next question as if this one had been answered.
 */
const INCOMPLETE_REASONS: Record<string, StopReason> = {
  max_output_tokens: 'max_tokens',
  content_filter: 'refusal',
}

/** The closing event, which carries what the turn cost and why it ended. */
function absorb(event: Event, progress: Progress): void {
  const usage = event.response?.usage
  // Taken off the fresh count, as the chat dialect does with its own figure:
  // `input_tokens` is the whole prompt with the cached part inside it, so
  // counting both charges twice for the same tokens — and the cached part is
  // billed at a fraction, which on a long conversation is most of the bill.
  const cached = usage?.input_tokens_details?.cached_tokens ?? 0
  progress.usage.inputTokens = Math.max(0, (usage?.input_tokens ?? 0) - cached)
  if (cached > 0) progress.usage.cacheReadTokens = cached
  progress.usage.outputTokens = usage?.output_tokens ?? 0

  const reason = INCOMPLETE_REASONS[event.response?.incomplete_details?.reason ?? '']
  if (reason) progress.stopReason = reason
}

/** One event, or nothing: `data: null` is legal and is not an event. */
function parse(raw: string, providerId: string): Event {
  try {
    const parsed: unknown = JSON.parse(raw)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Event)
      : {}
  } catch (cause) {
    throw new ProviderProtocolError(
      `provider ${providerId} sent an event that is not valid JSON`,
      { provider: providerId },
      { cause },
    )
  }
}

/** Blocks the canonical model has that this dialect drops. */
export const DROPPED: ContentBlock['type'][] = ['thinking']
