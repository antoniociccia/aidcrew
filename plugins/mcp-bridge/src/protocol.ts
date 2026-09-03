/**
 * The MCP wire protocol: JSON-RPC 2.0, and the handful of methods that matter
 * for using somebody else's tools.
 *
 * Kept apart from the transports so that speaking the protocol and getting
 * bytes to a server are two separate problems — which they are, since a server
 * over stdio and a server over HTTP differ in nothing above this line.
 */

export type JsonRpcRequest = {
  jsonrpc: '2.0'
  id: number | string
  method: string
  params?: unknown
}

export type JsonRpcNotification = {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export type JsonRpcResponse = {
  jsonrpc: '2.0'
  id: number | string
  result?: unknown
  error?: { code: number; message: string; data?: unknown }
}

/** The version of the protocol this client speaks. */
export const PROTOCOL_VERSION = '2025-06-18'

export type McpTool = {
  name: string
  description?: string
  inputSchema?: Record<string, unknown>
}

/**
 * What a server sends back from a tool call.
 *
 * Content is a list of typed blocks because a tool may answer with text, an
 * image, or a reference to something else. Only text survives into our model
 * today; the rest is named rather than dropped silently, so a tool answering
 * with a picture reads as "a picture" and not as an empty result.
 */
export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: 'audio'; data: string; mimeType: string }
  | { type: 'resource'; resource?: { uri?: string; text?: string } }
  | { type: string; [key: string]: unknown }

export type McpToolResult = {
  content?: McpContent[]
  isError?: boolean
  structuredContent?: unknown
}

/** Flattens a tool result into the string our tools return. */
export function renderResult(result: McpToolResult): string {
  const blocks = result.content ?? []

  const rendered = blocks.map((block) => {
    if (block.type === 'text') return (block as { text?: string }).text ?? ''
    if (block.type === 'resource') {
      const resource = (block as { resource?: { uri?: string; text?: string } }).resource
      return resource?.text ?? `[resource ${resource?.uri ?? 'with no uri'}]`
    }
    if (block.type === 'image' || block.type === 'audio') {
      // Named rather than inlined: base64 in a tool result is thousands of
      // tokens of nothing the model can read.
      return `[${block.type}: ${(block as { mimeType?: string }).mimeType ?? 'unknown type'}]`
    }
    return `[${block.type}]`
  })

  const text = rendered.filter((part) => part !== '').join('\n')
  if (text !== '') return text

  // A result with no content at all is a successful call that said nothing,
  // which is different from a failure and should not read like one.
  if (result.structuredContent !== undefined) return JSON.stringify(result.structuredContent)
  return '(the tool returned nothing)'
}

/** An error the server reported, rather than one the transport hit. */
export class McpError extends Error {
  override readonly name = 'McpError'

  constructor(
    readonly server: string,
    message: string,
    readonly code?: number,
  ) {
    super(`${server}: ${message}`)
  }
}
