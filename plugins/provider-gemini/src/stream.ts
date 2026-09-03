import type { StopReason, StreamDelta, Usage } from '@aidcrew/core'
import { ProviderProtocolError, ProviderResponseError } from '@aidcrew/core'
import { parseSse } from '@aidcrew/plugin-sdk'

/**
 * The streaming half of generateContent.
 *
 * Each event is a whole candidate rather than a delta on one, so what arrives
 * is already assembled: text comes in chunks, but a function call arrives
 * complete, arguments and all.
 *
 * That completeness is the problem this file solves. Our model identifies a
 * tool call so a result can be matched to it, and this protocol gives a call
 * no identity at all — two calls to the same function in one turn are
 * indistinguishable on the wire. So an id is minted here, per call, and the
 * request builder maps it back to a name on the way out.
 *
 * Minted once for the life of the process, not once per stream. A counter
 * that started over each turn gave every turn of every conversation a
 * `gemini-call-1`, and a history with the same id on two calls can no longer
 * say which result answered which — the `read` result from turn one went out
 * under the name of the `bash` call from turn two.
 */

/**
 * What a thinking model signed a call with, by the id the call was given.
 *
 * A Gemini 3 model attaches a `thoughtSignature` to a function call and
 * answers 400 to any later request in which that call comes back without it.
 * It has no place in the canonical model — it is not the call, and a tool
 * must never see it — so it travels beside the conversation, keyed by the
 * id, and the request builder puts it back on the way out.
 *
 * Calls only. The service signs text parts too, but does not insist on
 * seeing those again, and the canonical model gives a run of text no
 * identity to key one by — deltas are merged into one block on arrival.
 */
export type ThoughtSignatures = Map<string, string>

type Part = {
  text?: string
  /** Marks a part as reasoning rather than answer. */
  thought?: boolean
  functionCall?: { name?: string; args?: unknown }
  thoughtSignature?: string
}

type Event = {
  candidates?: {
    content?: { parts?: Part[]; role?: string }
    finishReason?: string
  }[]
  usageMetadata?: {
    promptTokenCount?: number
    candidatesTokenCount?: number
    cachedContentTokenCount?: number
    thoughtsTokenCount?: number
  }
  error?: { message?: string; code?: number; status?: string }
}

/** Statuses where sending the same request again can succeed. */
const RETRYABLE = new Set([429, 500, 502, 503, 504])

const STOP_REASONS: Record<string, StopReason> = {
  STOP: 'end_turn',
  MAX_TOKENS: 'max_tokens',
  SAFETY: 'refusal',
  RECITATION: 'refusal',
  PROHIBITED_CONTENT: 'refusal',
  SPII: 'refusal',
  BLOCKLIST: 'refusal',
}

export async function* parseGeminiStream(
  body: AsyncIterable<Uint8Array>,
  providerId: string,
  signatures?: ThoughtSignatures,
): AsyncIterable<StreamDelta> {
  let usage: Usage = { inputTokens: 0, outputTokens: 0 }
  let stopReason: StopReason = 'end_turn'
  let sawToolCall = false
  const open: string[] = []

  for await (const raw of parseSse(body)) {
    if (raw === '[DONE]') break
    const event = parse(raw, providerId)

    if (event.error) {
      throw new ProviderResponseError(
        event.error.message ?? 'the provider reported an error',
        providerId,
        RETRYABLE.has(event.error.code ?? 0),
      )
    }

    if (event.usageMetadata) usage = absorb(event.usageMetadata)

    for (const candidate of event.candidates ?? []) {
      for (const part of candidate.content?.parts ?? []) {
        if (part.functionCall) {
          const id = `gemini-call-${crypto.randomUUID()}`
          open.push(id)
          sawToolCall = true
          if (part.thoughtSignature !== undefined) signatures?.set(id, part.thoughtSignature)

          yield { type: 'tool_use_start', id, name: part.functionCall.name ?? '' }
          yield {
            type: 'tool_use_delta',
            id,
            partialInput: JSON.stringify(part.functionCall.args ?? {}),
          }
          yield { type: 'tool_use_end', id }
          open.pop()
          continue
        }

        if (part.text === undefined || part.text === '') continue
        yield part.thought === true
          ? { type: 'thinking_delta', text: part.text }
          : { type: 'text_delta', text: part.text }
      }

      const finish = candidate.finishReason
      if (finish !== undefined && finish !== 'STOP') {
        stopReason = STOP_REASONS[finish] ?? 'end_turn'
      }
    }
  }

  // A stream cut short can leave a call open. Closing it lets the caller decide
  // what to do with half a call rather than wait for an end that is not coming.
  for (const id of open) yield { type: 'tool_use_end', id }

  yield {
    type: 'done',
    stopReason: stopReason === 'end_turn' && sawToolCall ? 'tool_use' : stopReason,
    usage,
  }
}

/**
 * The bill.
 *
 * `promptTokenCount` already includes the cached part, so the cached part is
 * taken back out of it. The canonical counts are disjoint — every consumer
 * adds all four together, from the governor's budget to the row on screen —
 * and reporting the prompt total whole beside the cached figure charged a
 * hundred-token turn with eighty cached for a hundred and eighty. The error is
 * largest exactly where caching is heaviest, which is every long conversation.
 *
 * Clamped at zero because a service reporting more cached tokens than prompt
 * ones should cost us a wrong number rather than a negative one.
 */
function absorb(metadata: NonNullable<Event['usageMetadata']>): Usage {
  const cached = metadata.cachedContentTokenCount ?? 0
  return {
    inputTokens: Math.max(0, (metadata.promptTokenCount ?? 0) - cached),
    // Thinking is billed as output and reported separately, so a turn that
    // thought hard would otherwise look cheap.
    outputTokens: (metadata.candidatesTokenCount ?? 0) + (metadata.thoughtsTokenCount ?? 0),
    ...(cached > 0 ? { cacheReadTokens: cached } : {}),
  }
}

function parse(raw: string, providerId: string): Event {
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
