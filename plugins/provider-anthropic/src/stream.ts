import type { StopReason, StreamDelta, Usage } from '@aidcrew/core'
import { ProviderProtocolError, ProviderResponseError } from '@aidcrew/core'
import { parseSse } from '@aidcrew/plugin-sdk'

/**
 * The Messages API streams typed events rather than diff chunks, so the shape
 * here is quite different from the OpenAI one — which is the point: the
 * canonical model absorbs both without either knowing about the other.
 */
type Event = {
  type: string
  index?: number
  content_block?: { type: string; id?: string; name?: string }
  delta?: {
    type?: string
    text?: string
    thinking?: string
    partial_json?: string
    stop_reason?: string
  }
  message?: {
    usage?: {
      input_tokens?: number
      output_tokens?: number
      cache_creation_input_tokens?: number
      cache_read_input_tokens?: number
    }
  }
  usage?: { input_tokens?: number; output_tokens?: number }
  error?: { type?: string; message?: string }
}

const STOP_REASONS: Record<string, StopReason> = {
  end_turn: 'end_turn',
  tool_use: 'tool_use',
  max_tokens: 'max_tokens',
  stop_sequence: 'stop_sequence',
  refusal: 'refusal',
}

const RETRYABLE = new Set(['overloaded_error', 'rate_limit_error', 'api_error'])

export async function* parseAnthropicStream(
  body: AsyncIterable<Uint8Array>,
  providerId: string,
): AsyncIterable<StreamDelta> {
  /** Block ids by their index, since deltas refer to blocks by position. */
  const openBlocks = new Map<number, string>()
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let stopReason: StopReason = 'end_turn'

  for await (const raw of parseSse(body)) {
    const event = parseEvent(raw, providerId)

    if (event.error) {
      throw new ProviderResponseError(
        event.error.message ?? 'the provider reported an error',
        providerId,
        RETRYABLE.has(event.error.type ?? ''),
      )
    }

    if (event.type === 'message_start') {
      readPrompt(event.message?.usage, usage)
      continue
    }
    if (event.type === 'message_delta') {
      if (event.delta?.stop_reason) {
        stopReason = STOP_REASONS[event.delta.stop_reason] ?? 'end_turn'
      }
      usage.outputTokens = event.usage?.output_tokens ?? usage.outputTokens
      continue
    }

    yield* blockEvent(event, openBlocks)
  }

  yield { type: 'done', stopReason, usage }
}

/**
 * Everything the opening event says the prompt cost.
 *
 * A cached read is billed at about a tenth of the input rate and a cached
 * write at more than it, so a turn counted without them is wrong in both
 * directions at once. Nothing is subtracted here: this dialect already reports
 * the three as separate counts of separate tokens, which is the convention the
 * canonical `Usage` keeps.
 */
function readPrompt(reported: NonNullable<Event['message']>['usage'], usage: Usage): void {
  usage.inputTokens = reported?.input_tokens ?? 0

  const cacheRead = reported?.cache_read_input_tokens ?? 0
  const cacheWrite = reported?.cache_creation_input_tokens ?? 0
  if (cacheRead > 0) usage.cacheReadTokens = cacheRead
  if (cacheWrite > 0) usage.cacheWriteTokens = cacheWrite
}

/** The three events that describe a content block's life. */
function* blockEvent(event: Event, openBlocks: Map<number, string>): Generator<StreamDelta> {
  switch (event.type) {
    case 'content_block_start':
      yield* openBlock(event, openBlocks)
      break
    case 'content_block_delta':
      yield* blockDelta(event, openBlocks)
      break
    case 'content_block_stop': {
      const id = openBlocks.get(event.index ?? -1)
      if (id !== undefined) {
        openBlocks.delete(event.index ?? -1)
        yield { type: 'tool_use_end', id }
      }
      break
    }
    default:
      break
  }
}

function* openBlock(event: Event, openBlocks: Map<number, string>): Generator<StreamDelta> {
  if (event.content_block?.type !== 'tool_use') return

  const id = event.content_block.id
  if (!id) {
    throw new ProviderProtocolError('tool_use block arrived without an id', {
      provider: 'anthropic',
    })
  }
  openBlocks.set(event.index ?? 0, id)
  yield { type: 'tool_use_start', id, name: event.content_block.name ?? '' }
}

function* blockDelta(event: Event, openBlocks: Map<number, string>): Generator<StreamDelta> {
  const delta = event.delta
  if (!delta) return

  if (delta.type === 'text_delta' && delta.text) {
    yield { type: 'text_delta', text: delta.text }
    return
  }
  if (delta.type === 'thinking_delta' && delta.thinking) {
    yield { type: 'thinking_delta', text: delta.thinking }
    return
  }
  if (delta.type === 'input_json_delta' && delta.partial_json !== undefined) {
    const id = openBlocks.get(event.index ?? -1)
    if (id !== undefined) {
      yield { type: 'tool_use_delta', id, partialInput: delta.partial_json }
    }
  }
}

function parseEvent(raw: string, providerId: string): Event {
  try {
    return JSON.parse(raw) as Event
  } catch (cause) {
    throw new ProviderProtocolError(
      `provider ${providerId} sent an event that is not valid JSON`,
      { provider: providerId },
      { cause },
    )
  }
}
