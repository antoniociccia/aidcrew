import type { CanonicalRequest, ContentBlock, Message } from '@aidcrew/core'

/** The subset of the chat-completions body this provider produces. */
export type OpenAiMessage =
  | { role: 'system'; content: string }
  | { role: 'user'; content: string | OpenAiPart[] }
  | { role: 'assistant'; content: string; tool_calls?: OpenAiToolCall[] }
  | { role: 'tool'; tool_call_id: string; content: string }

/**
 * A user message with a picture in it is a list of parts rather than a string.
 *
 * Only the user role takes them here — an assistant does not send pictures,
 * and a tool result is a string by definition on this API.
 */
export type OpenAiPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } }

export type OpenAiToolCall = {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export type OpenAiRequestBody = {
  model: string
  messages: OpenAiMessage[]
  max_tokens: number
  stream: true
  stream_options: { include_usage: true }
  tools?: { type: 'function'; function: Record<string, unknown> }[]
  temperature?: number
}

/**
 * Translates the canonical request into a chat-completions body.
 *
 * This is one half of what a provider plugin is: the core never learns this
 * shape, and this file never learns how the agent loop works.
 */
export function buildRequestBody(request: CanonicalRequest): OpenAiRequestBody {
  const messages: OpenAiMessage[] = []
  if (request.system !== '') {
    messages.push({ role: 'system', content: request.system })
  }
  for (const message of request.messages) {
    messages.push(...translate(message))
  }

  return {
    model: request.model,
    messages,
    max_tokens: request.maxTokens,
    stream: true,
    stream_options: { include_usage: true },
    // Some gateways reject `tools: []`, so the field is absent rather than empty.
    ...(request.tools.length === 0
      ? {}
      : {
          tools: request.tools.map((tool) => ({
            type: 'function' as const,
            function: {
              name: tool.name,
              description: tool.description,
              parameters: tool.inputSchema,
            },
          })),
        }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  }
}

function translate(message: Message): OpenAiMessage[] {
  // Tool results are their own role here, so one canonical message can become
  // several: the shapes do not line up one to one.
  const results = message.content.filter((block) => block.type === 'tool_result')
  if (results.length > 0) {
    return results.map((block) => ({
      role: 'tool' as const,
      tool_call_id: block.toolUseId,
      content: block.content,
    }))
  }

  const text = textOf(message.content)

  if (message.role === 'assistant') {
    const calls = message.content.filter((block) => block.type === 'tool_use')
    return [
      {
        role: 'assistant',
        content: text,
        ...(calls.length === 0
          ? {}
          : {
              tool_calls: calls.map((call) => ({
                id: call.id,
                type: 'function' as const,
                function: { name: call.name, arguments: JSON.stringify(call.input) },
              })),
            }),
      },
    ]
  }

  if (message.role === 'system') return [{ role: 'system', content: text }]

  // A picture makes the content a list of parts. Sent as a data URL, which is
  // what this API calls an image it was not asked to fetch: an agent's
  // pictures are pasted, not published, so there is no address to give.
  const pictures = message.content.filter((block) => block.type === 'image')
  if (pictures.length === 0) return [{ role: 'user', content: text }]

  return [
    {
      role: 'user',
      content: [
        ...(text === '' ? [] : [{ type: 'text' as const, text }]),
        ...pictures.map((block) => ({
          type: 'image_url' as const,
          image_url: { url: `data:${block.mediaType};base64,${block.data}` },
        })),
      ],
    },
  ]
}

/**
 * Thinking is deliberately dropped: providers reject their own reasoning when
 * it is echoed back, and it is not part of the conversation the model needs.
 */
function textOf(content: ContentBlock[]): string {
  return content
    .filter((block) => block.type === 'text')
    .map((block) => block.text)
    .join('')
}
