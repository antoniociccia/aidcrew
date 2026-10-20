// Asks a live model through an aidcrew provider. The provider is injected so
// this package never holds keys or endpoints; the interfaces mirror the core
// provider shapes structurally, so any real provider fits without this package
// depending on core. An unparsable answer is passed on without an action, so
// the runner records it as rejected with its raw text and the agent waits —
// the same thing a replay of that text does; provider failures throw, so the
// run fails fast with the reason instead of recording a tick of waits.
import type { Decider, DecisionInput, DecisionOutput, Usage } from '../contracts.ts'
import { parseDecision } from './parse.ts'
import { buildMessages } from './prompt.ts'

/** The slice of a provider this decider needs. Declared as methods so any real
 *  provider is assignable without importing its types. */
export interface AidcrewProvider {
  readonly id: string
  send(request: AidcrewRequest, signal: AbortSignal): AsyncIterable<AidcrewDelta>
}

export interface AidcrewRequest {
  model: string
  system: string
  messages: { role: 'system' | 'user' | 'assistant'; content: { type: 'text'; text: string }[] }[]
  tools: { name: string; description: string; inputSchema: Record<string, unknown> }[]
  maxTokens: number
  temperature?: number
}

export interface AidcrewUsage {
  inputTokens: number
  outputTokens: number
  cacheReadTokens?: number
  cacheWriteTokens?: number
  chargedUsd?: number
  listedUsd?: number
  unstatedTurns?: number
}

export type AidcrewDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; text: string }
  | { type: 'tool_use_start'; id: string; name: string }
  | { type: 'tool_use_delta'; id: string; partialInput: string }
  | { type: 'tool_use_end'; id: string }
  | { type: 'meter'; providerId: string; windows: unknown[] }
  | { type: 'done'; stopReason: string; usage: AidcrewUsage }

export interface AidcrewDeciderOptions {
  provider: AidcrewProvider
  providerId: string
  model: string
  maxTokens?: number
  temperature?: number
}

export function aidcrewDecider(opts: AidcrewDeciderOptions): Decider {
  return {
    name: `aidcrew:${opts.providerId}/${opts.model}`,
    decide: async (input: DecisionInput): Promise<DecisionOutput> => {
      const request = buildAidcrewRequest(opts, input)
      const seen = await streamRaw(opts.provider, request)
      return toDecision(seen.raw, seen.usage)
    },
  }
}

function buildAidcrewRequest(opts: AidcrewDeciderOptions, input: DecisionInput): AidcrewRequest {
  // buildMessages puts the system prompt first; the request carries it
  // apart from the turn, and the tools stay empty — the decision is text.
  const [first, ...rest] = buildMessages(input)
  const request: AidcrewRequest = {
    model: opts.model,
    system: first?.content ?? '',
    messages: rest.map((m) => ({ role: m.role, content: [{ type: 'text', text: m.content }] })),
    tools: [],
    maxTokens: opts.maxTokens ?? 1024,
  }
  if (opts.temperature !== undefined) request.temperature = opts.temperature
  return request
}

interface Streamed {
  raw: string
  usage?: Usage
}

async function streamRaw(provider: AidcrewProvider, request: AidcrewRequest): Promise<Streamed> {
  let raw = ''
  let usage: Usage | undefined
  for await (const delta of provider.send(request, new AbortController().signal)) {
    if (delta.type === 'text_delta') raw += delta.text
    else if (delta.type === 'done') usage = toUsage(delta.usage)
  }
  return usage === undefined ? { raw } : { raw, usage }
}

function toDecision(raw: string, usage: Usage | undefined): DecisionOutput {
  const parsed = parseDecision(raw)
  if (parsed.rationale === undefined) {
    return usage === undefined
      ? { raw, action: parsed.action }
      : { raw, action: parsed.action, usage }
  }
  return usage === undefined
    ? { raw, action: parsed.action, rationale: parsed.rationale }
    : { raw, action: parsed.action, rationale: parsed.rationale, usage }
}

function toUsage(u: AidcrewUsage): Usage {
  return {
    promptTokens: u.inputTokens,
    completionTokens: u.outputTokens,
    costUsd: u.chargedUsd ?? u.listedUsd ?? 0,
  }
}
