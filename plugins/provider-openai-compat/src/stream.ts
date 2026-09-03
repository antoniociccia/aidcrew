import type { StopReason, StreamDelta, Usage } from '@aidcrew/core'
import { ProviderProtocolError, ProviderResponseError } from '@aidcrew/core'
import { parseSse } from '@aidcrew/plugin-sdk'
import { notAStream, remembering } from './body.ts'

type ToolCallChunk = {
  /** Standard, but some proxies leave it out and identify chunks by id alone. */
  index?: number
  id?: string
  function?: { name?: string; arguments?: string }
}

/**
 * Open tool calls, under every key a later chunk might name them by.
 *
 * A call is opened by one chunk and continued by others, and services do not
 * agree on how those refer back to it: some send an `index` every time, some
 * an `id` every time, and some — qwen through opencode-go, watched — send the
 * id on the chunk carrying the name and the index on every chunk after it.
 * Keyed by whichever field happened to be present, that was two calls: the
 * name arrived with no arguments and the arguments arrived with no name.
 *
 * So a call is registered under both, and a chunk carrying either finds it. A
 * number and a string never collide, since a map keeps `0` and `"0"` apart.
 */
type OpenCalls = Map<number | string, string>

/** What a choice carries: as `delta` on a chunk, as `message` on a completion sent whole. */
type Delta = {
  content?: string | null
  /** Non-standard, but how DeepSeek, GLM and others stream reasoning. */
  reasoning_content?: string | null
  /**
   * The same thing under the name OpenRouter-shaped gateways use, OpenCode
   * Go among them. Two names because the field was never standardised, and
   * a gateway that proxies several upstreams may pass through either.
   */
  reasoning?: string | null
  tool_calls?: ToolCallChunk[]
}

/** A chunk is only read through these fields; everything else is ignored. */
type Chunk = {
  choices?: {
    delta?: Delta
    message?: Delta
    finish_reason?: string | null
  }[]
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    /** Where a service that caches says how much of the prompt it had already. */
    prompt_tokens_details?: { cached_tokens?: number }
    /** The same figure under the name DeepSeek gave it before the field above existed. */
    prompt_cache_hit_tokens?: number
  } | null
  error?: { message?: string; type?: string } | null
}

const FINISH_REASONS: Record<string, StopReason> = {
  stop: 'end_turn',
  tool_calls: 'tool_use',
  function_call: 'tool_use',
  length: 'max_tokens',
  content_filter: 'refusal',
}

const RETRYABLE_ERROR_TYPES = new Set([
  'rate_limit',
  'rate_limit_error',
  'server_error',
  'overloaded_error',
])

/**
 * Translates a chat-completions stream into canonical deltas.
 *
 * The `done` delta is held back until the stream ends rather than emitted on
 * `finish_reason`, because usage arrives in a chunk *after* the finish reason
 * — and a turn that reports no cost is a turn nobody can budget for.
 */
export async function* parseOpenAiStream(
  body: AsyncIterable<Uint8Array>,
  providerId: string,
): AsyncIterable<StreamDelta> {
  const openCalls: OpenCalls = new Map()
  const usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let stopReason: StopReason | undefined
  const seen = remembering(body)
  let events = 0

  for await (const event of parseSse(seen.bytes)) {
    events++
    if (event === '[DONE]') break

    const chunk = parseChunk(event, providerId)
    raiseReportedError(chunk, providerId)
    stopReason = (yield* readChunk(chunk, openCalls, usage, providerId)) ?? stopReason
  }

  // No events at all is not a model with nothing to say: it is a body that
  // was never a stream. Either the gateway ignored `stream: true` and sent
  // the completion whole, which is read as one big chunk, or it answered 200
  // with a refusal — and that sentence is what the caller needs to see.
  if (events === 0) {
    stopReason = yield* readChunk(
      completionIn(seen.text(), providerId),
      openCalls,
      usage,
      providerId,
    )
  }

  // Once each: a call is registered under every key a chunk might name it by,
  // so the same id is in this map more than once.
  for (const id of new Set(openCalls.values())) {
    yield { type: 'tool_use_end', id }
  }

  // A stream can end without a finish reason when a gateway drops the
  // connection. Having opened a tool call is the better guess in that case.
  yield {
    type: 'done',
    stopReason: stopReason ?? (openCalls.size > 0 ? 'tool_use' : 'end_turn'),
    usage,
  }
}

function raiseReportedError(chunk: Chunk, providerId: string): void {
  if (!chunk.error) return
  throw new ProviderResponseError(
    chunk.error.message ?? 'the provider reported an error',
    providerId,
    RETRYABLE_ERROR_TYPES.has(chunk.error.type ?? ''),
  )
}

function applyUsage(usage: Usage, chunk: Chunk): void {
  if (!chunk.usage) return
  // Taken off the fresh count rather than added to it. Unlike Anthropic's,
  // this dialect's `prompt_tokens` is the whole prompt with the cached part
  // inside it, so counting both charges for the same tokens twice — and the
  // cached part is billed at a fraction, which is the difference between a
  // long conversation costing what it looks like and costing a tenth of it.
  const cached =
    chunk.usage.prompt_tokens_details?.cached_tokens ?? chunk.usage.prompt_cache_hit_tokens ?? 0
  usage.inputTokens = Math.max(0, (chunk.usage.prompt_tokens ?? 0) - cached)
  if (cached > 0) usage.cacheReadTokens = cached
  usage.outputTokens = chunk.usage.completion_tokens ?? 0
}

/** Everything one chunk has to say, and the stop reason if it named one. */
function* readChunk(
  chunk: Chunk,
  openCalls: OpenCalls,
  usage: Usage,
  providerId: string,
): Generator<StreamDelta, StopReason | undefined> {
  applyUsage(usage, chunk)

  const choice = chunk.choices?.[0]
  if (!choice) return undefined

  yield* readDelta(choice.delta ?? choice.message, openCalls, providerId)
  return choice.finish_reason ? (FINISH_REASONS[choice.finish_reason] ?? 'end_turn') : undefined
}

/** A completion sent whole, or the error for a body that is neither that nor a stream. */
function completionIn(text: string, providerId: string): Chunk {
  try {
    const parsed = JSON.parse(text) as Chunk
    if (Array.isArray(parsed.choices) && parsed.choices.length > 0) return parsed
  } catch {
    // Not JSON at all — a login page, say — which the error quotes the start of.
  }
  throw notAStream(text, providerId)
}

function* readDelta(
  delta: Delta | undefined,
  openCalls: OpenCalls,
  providerId: string,
): Generator<StreamDelta> {
  // Either name, never both: a gateway that sends both sends the same text in
  // each, and showing a thought twice reads as the model repeating itself.
  const thought = delta?.reasoning_content ?? delta?.reasoning
  if (thought) {
    yield { type: 'thinking_delta', text: thought }
  }
  if (delta?.content) {
    yield { type: 'text_delta', text: delta.content }
  }
  for (const call of delta?.tool_calls ?? []) {
    yield* readToolCall(call, openCalls, providerId)
  }
}

function* readToolCall(
  call: ToolCallChunk,
  openCalls: OpenCalls,
  providerId: string,
): Generator<StreamDelta> {
  // An empty id is no id. Several services send `id: ""` on every chunk after
  // the one that opened a call — qwen through opencode-go on every turn —
  // and taken at face value that empty string became a key of its own: the
  // first call was filed under it, so every later continuation of every later
  // call resolved to the first. One call ended up holding two calls'
  // arguments, which is not JSON, and the other held none.
  const named = call.id === undefined || call.id === '' ? undefined : call.id

  // By id first, because an id is a name for one call and an index is only a
  // position — and a service that reuses index 0 for every call, as Gemini's
  // OpenAI-compatible endpoint does, makes the position a lie.
  const byId = named === undefined ? undefined : openCalls.get(named)
  const byIndex = call.index === undefined ? undefined : openCalls.get(call.index)
  let id = byId ?? byIndex

  // A chunk that carries a name is opening a call; one that does not is
  // continuing whichever call it belongs to. That distinction is what makes
  // the rest of this readable, because the keys alone do not say.
  const opening = call.function?.name !== undefined

  // An id nobody has seen, opening a call at a position that is taken, is a
  // second call rather than more of the first. Read as a continuation, the
  // second lost its name and its arguments were glued onto the other's,
  // which no longer parsed as JSON.
  if (opening && byId === undefined && byIndex !== undefined && named !== undefined) {
    yield { type: 'tool_use_end', id: byIndex }
    forget(openCalls, byIndex)
    id = undefined
  }

  // A continuation whose key nobody has seen belongs to the call still open:
  // it is not naming anything, and there is nothing else it could be part
  // of. This is the qwen case, where the name arrives under an id and every
  // chunk after it under an index.
  if (id === undefined && !opening) {
    id = [...new Set(openCalls.values())].at(-1)
  }

  if (id === undefined) {
    // The id is optional on the wire, and several services never send one:
    // the index is the identity, the name comes in the first chunk and the
    // arguments in the ones after it. Read as a continuation of a call that
    // was never opened, the whole turn died — watched on qwen3.8-flash, on
    // the first request of a session, every time. So one is minted, unique
    // for the life of the process, and everything downstream matches a
    // result to its call by it as usual.
    id = named ?? `${providerId}-call-${crypto.randomUUID()}`
    // Under both keys, so a later chunk finds it whichever one it carries.
    if (call.index !== undefined) openCalls.set(call.index, id)
    openCalls.set(id, id)
    yield { type: 'tool_use_start', id, name: call.function?.name ?? '' }
  } else {
    // A call opened under one key and continued under the other: remember
    // the new key too, so the one after it needs no guessing either.
    if (call.index !== undefined && byIndex === undefined) openCalls.set(call.index, id)
    if (named !== undefined && byId === undefined) openCalls.set(named, id)
  }

  if (call.function?.arguments) {
    yield { type: 'tool_use_delta', id, partialInput: call.function.arguments }
  }
}

/** Takes a call out from under every key it was registered by. */
function forget(openCalls: OpenCalls, id: string): void {
  for (const [key, held] of openCalls) if (held === id) openCalls.delete(key)
}

/**
 * One event as a chunk, or as nothing.
 *
 * `data: null` is a legal event, and so is an array. Read as a chunk, either
 * threw a TypeError from inside the parser — not a provider error, not a
 * protocol error, a crash with a stack trace where the answer should have
 * been. Anything that is not an object is a keep-alive as far as this
 * reader is concerned.
 */
function parseChunk(event: string, providerId: string): Chunk {
  try {
    const parsed: unknown = JSON.parse(event)
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Chunk)
      : {}
  } catch (cause) {
    throw new ProviderProtocolError(
      `provider ${providerId} sent a chunk that is not valid JSON`,
      { provider: providerId },
      { cause },
    )
  }
}
