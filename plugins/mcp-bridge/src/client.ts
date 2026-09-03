import type { JsonRpcResponse, McpTool, McpToolResult } from './protocol.ts'
import { McpError, PROTOCOL_VERSION } from './protocol.ts'

/**
 * A connection to one MCP server.
 *
 * The transport is injected rather than chosen here: a server running as a
 * child process and one answering over HTTP differ in how bytes move and in
 * nothing else, so the protocol is written once and the difference lives in
 * two small files next door.
 */

export type Transport = {
  /** Sends a request and resolves with the matching response. */
  request(method: string, params: unknown, signal: AbortSignal): Promise<JsonRpcResponse>
  /** Sends a notification, which by definition has no answer. */
  notify(method: string, params: unknown): Promise<void>
  close(): Promise<void>
}

export type ServerInfo = { name?: string; version?: string }

export class McpClient {
  #tools: McpTool[] = []
  #info: ServerInfo = {}
  #ready = false

  constructor(
    readonly name: string,
    private readonly transport: Transport,
  ) {}

  /**
   * The handshake, then the tool list.
   *
   * `initialized` is a notification and not a request: a server that waits for
   * an answer to it deadlocks, and one that never receives it refuses
   * everything after with "not initialized". Both failures look like the
   * server hanging, which is why this order is not negotiable.
   */
  async connect(signal: AbortSignal): Promise<void> {
    const initialised = await this.#call(
      'initialize',
      {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'aidcrew', version: '0.1.0' },
      },
      signal,
    )

    this.#info = (initialised as { serverInfo?: ServerInfo }).serverInfo ?? {}
    await this.transport.notify('notifications/initialized', {})
    this.#ready = true

    await this.refresh(signal)
  }

  /** Asks the server what it can do. */
  async refresh(signal: AbortSignal): Promise<McpTool[]> {
    const listed = await this.#call('tools/list', {}, signal)
    this.#tools = ((listed as { tools?: McpTool[] }).tools ?? []).filter(
      (tool) => typeof tool.name === 'string' && tool.name !== '',
    )
    return this.#tools
  }

  get tools(): McpTool[] {
    return this.#tools
  }

  get info(): ServerInfo {
    return this.#info
  }

  get connected(): boolean {
    return this.#ready
  }

  async callTool(name: string, args: unknown, signal: AbortSignal): Promise<McpToolResult> {
    const result = await this.#call('tools/call', { name, arguments: args ?? {} }, signal)
    return result as McpToolResult
  }

  async close(): Promise<void> {
    this.#ready = false
    await this.transport.close()
  }

  async #call(method: string, params: unknown, signal: AbortSignal): Promise<unknown> {
    const response = await this.transport.request(method, params, signal)
    if (response.error) {
      throw new McpError(this.name, response.error.message, response.error.code)
    }
    return response.result ?? {}
  }
}
