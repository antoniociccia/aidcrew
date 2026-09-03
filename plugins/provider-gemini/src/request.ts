import type { CanonicalRequest, ContentBlock, Message } from '@aidcrew/core'

/**
 * The generateContent shape — the third dialect, and the one least like the
 * other two.
 *
 * Messages are `contents`, the assistant is called `model`, the system prompt
 * is `systemInstruction`, tools are function declarations nested one level
 * deeper than anywhere else, and a tool call carries no identity of its own.
 * That last one is the difference that matters, and it is handled below.
 */

export type GeminiPart =
  | { text: string }
  | { text: string; thought: true }
  | { functionCall: { name: string; args: unknown }; thoughtSignature?: string }
  | { functionResponse: { name: string; response: unknown } }
  | { inlineData: { mimeType: string; data: string } }

export type GeminiContent = { role: 'user' | 'model'; parts: GeminiPart[] }

export type GeminiRequestBody = {
  contents: GeminiContent[]
  systemInstruction?: { parts: { text: string }[] }
  tools?: { functionDeclarations: GeminiFunction[] }[]
  generationConfig: { maxOutputTokens: number; temperature?: number }
}

type GeminiFunction = {
  name: string
  description: string
  parameters: Record<string, unknown>
}

export function buildRequestBody(
  request: CanonicalRequest,
  signatures?: ReadonlyMap<string, string>,
): GeminiRequestBody {
  // A call's name, by the id our model gave it. This dialect matches a result
  // to its call by function name, so the name has to be carried forward from
  // where it was seen — there is nothing in the result itself that says it.
  //
  // Filled while walking, never ahead of time: a result answers the last
  // call before it with that id, and nothing later. Gathered over the whole
  // conversation first, with the last one winning, a repeated id renamed
  // every earlier result after the latest call — and ids were repeated, one
  // `gemini-call-1` per turn, so this was every conversation with two turns
  // of tool use in it.
  const calledName = new Map<string, string>()
  const history: Conversation = { calledName, signatures }

  const contents = request.messages
    .filter((message) => message.role !== 'system')
    .map((message) => translate(message, history))
    // An empty turn is a 400 from this API, and turns do come out empty:
    // an assistant turn that was nothing but thinking has nothing left once
    // thinking is dropped.
    .filter((turn) => turn.parts.length > 0)

  return {
    contents,
    ...(request.system === '' ? {} : { systemInstruction: { parts: [{ text: request.system }] } }),
    ...(request.tools.length === 0
      ? {}
      : {
          tools: [
            {
              functionDeclarations: request.tools.map((tool) => ({
                name: tool.name,
                description: tool.description,
                parameters: cleanSchema(tool.inputSchema),
              })),
            },
          ],
        }),
    generationConfig: {
      maxOutputTokens: request.maxTokens,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
    },
  }
}

/** What the walk so far knows about the calls in this conversation. */
type Conversation = {
  calledName: Map<string, string>
  signatures: ReadonlyMap<string, string> | undefined
}

function translate(message: Message, history: Conversation): GeminiContent {
  return {
    // There is no assistant here, and no system either: everything that is not
    // the model is the user, tool results included.
    role: message.role === 'assistant' ? 'model' : 'user',
    parts: message.content.flatMap((block) => part(block, history)),
  }
}

function part(block: ContentBlock, history: Conversation): GeminiPart[] {
  if (block.type === 'text') return block.text === '' ? [] : [{ text: block.text }]

  if (block.type === 'image') {
    return [{ inlineData: { mimeType: block.mediaType, data: block.data } }]
  }

  if (block.type === 'tool_use') {
    history.calledName.set(block.id, block.name)
    // The signature goes back exactly where it came from, on this call and no
    // other: a thinking model refuses the request without it, and a call that
    // arrived unsigned — an older model, or the second of two parallel calls —
    // must go back unsigned too.
    const signature = history.signatures?.get(block.id)
    return [
      {
        functionCall: { name: block.name, args: block.input ?? {} },
        ...(signature === undefined ? {} : { thoughtSignature: signature }),
      },
    ]
  }

  if (block.type === 'tool_result') {
    return [
      {
        functionResponse: {
          name: history.calledName.get(block.toolUseId) ?? block.toolUseId,
          // Always an object: a bare string is rejected, and the field name is
          // ours to choose since the model only ever reads what is inside.
          response: block.isError ? { error: block.content } : { output: block.content },
        },
      },
    ]
  }

  // Thinking is dropped: it is not conversation, and replaying it is rejected.
  return []
}

/**
 * JSON Schema keywords this API does not accept.
 *
 * It takes a subset of OpenAPI rather than JSON Schema, and answers 400 —
 * naming the offending field, but rejecting the whole request — when it finds
 * anything else. `$schema` and `additionalProperties` are the ones that matter
 * in practice, because Zod emits both on every schema we generate, so leaving
 * this out does not break one tool: it breaks all of them at once.
 */
const UNSUPPORTED = new Set([
  '$schema',
  '$id',
  '$ref',
  'additionalProperties',
  'exclusiveMinimum',
  'exclusiveMaximum',
  'const',
  'default',
  'oneOf',
  'allOf',
  'not',
  'patternProperties',
  'definitions',
  '$defs',
])

export function cleanSchema(schema: unknown): Record<string, unknown> {
  return clean(schema) as Record<string, unknown>
}

function clean(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(clean)
  if (value === null || typeof value !== 'object') return value

  const out: Record<string, unknown> = {}
  for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
    if (UNSUPPORTED.has(key)) continue

    // `type: ["string", "null"]` is how a nullable field is written in JSON
    // Schema and is not understood here, where nullability is its own flag.
    if (key === 'type' && Array.isArray(inner)) {
      const types = inner.filter((entry) => entry !== 'null')
      out.type = types[0] ?? 'string'
      if (types.length !== inner.length) out.nullable = true
      continue
    }

    out[key] = clean(inner)
  }
  return out
}
