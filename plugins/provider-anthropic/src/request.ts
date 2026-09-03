import type { CanonicalRequest, ContentBlock, Message } from '@aidcrew/core'

/**
 * The Messages API shape. Closer to the canonical model than the OpenAI one:
 * content is already a list of blocks, and tool results already ride inside a
 * user message. Only the field names and the separate `system` differ.
 */
export type AnthropicBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error: boolean }
  | { type: 'image'; source: { type: 'base64'; media_type: string; data: string } }

export type AnthropicMessage = {
  role: 'user' | 'assistant'
  content: AnthropicBlock[]
}

export type AnthropicRequestBody = {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  stream: true
  /**
   * A block rather than a string, so it can carry a cache marker.
   *
   * This service holds a prefix and charges a tenth for it, and it has to be
   * asked — unlike the OpenAI dialect, where it happens on its own. Nothing
   * was ever asked, so a measured session paid full price for the same
   * conversation fifty times.
   */
  system?: { type: 'text'; text: string; cache_control?: { type: 'ephemeral' } }[]
  tools?: {
    name: string
    description: string
    input_schema: Record<string, unknown>
    cache_control?: { type: 'ephemeral' }
  }[]
  temperature?: number
}

/**
 * What this service calls a cache marker.
 *
 * The conversation itself is deliberately not marked: it changes every turn,
 * so a marker inside it caches a prefix that will not be there next time and
 * pays the write price — which is more than the input price — for something
 * read once. The stable half is the system prompt and the tools.
 */
const EPHEMERAL = { type: 'ephemeral' } as const

export function buildRequestBody(request: CanonicalRequest): AnthropicRequestBody {
  return {
    model: request.model,
    max_tokens: request.maxTokens,
    stream: true,
    // The system prompt is a top-level field here, never a message — and the
    // safest thing there is to cache: byte-identical on every turn of every
    // session, and long. A marker on an empty prefix is refused, so an empty
    // system prompt sends no field at all, as it always did.
    ...(request.system === ''
      ? {}
      : { system: [{ type: 'text' as const, text: request.system, cache_control: EPHEMERAL }] }),
    messages: request.messages
      .filter((message) => message.role !== 'system')
      .map(translate)
      // An empty content list is a 400 from this API, and turns do come out
      // empty: an assistant turn that was nothing but thinking has nothing
      // left once thinking is dropped. Dropping the turn is safe because the
      // service folds two consecutive turns of one role into one.
      .filter((turn) => turn.content.length > 0),
    ...(request.tools.length === 0
      ? {}
      : {
          // Marked on the last one, because the marker caches everything up
          // to where it sits. The schemas cost over a thousand tokens on
          // every request and do not change within a session.
          tools: request.tools.map((tool, at) => ({
            name: tool.name,
            description: tool.description,
            input_schema: tool.inputSchema,
            ...(at === request.tools.length - 1 ? { cache_control: EPHEMERAL } : {}),
          })),
        }),
    ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
  }
}

function translate(message: Message): AnthropicMessage {
  return {
    role: message.role === 'assistant' ? 'assistant' : 'user',
    content: message.content.flatMap(toBlock),
  }
}

/** Thinking is dropped: replaying it back is rejected, and it is not conversation. */
function toBlock(block: ContentBlock): AnthropicBlock[] {
  switch (block.type) {
    case 'text':
      return block.text === '' ? [] : [{ type: 'text', text: block.text }]
    case 'tool_use':
      return [{ type: 'tool_use', id: block.id, name: block.name, input: block.input }]
    case 'tool_result':
      return [
        {
          type: 'tool_result',
          tool_use_id: block.toolUseId,
          content: block.content,
          is_error: block.isError,
        },
      ]
    case 'image':
      return [
        {
          type: 'image',
          source: { type: 'base64', media_type: block.mediaType, data: block.data },
        },
      ]
    case 'thinking':
      return []
  }
}
