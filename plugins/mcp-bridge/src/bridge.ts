import type { Plugin, Tool, ToolContext, ToolOutput } from '@aidcrew/core'
import { definePlugin } from '@aidcrew/plugin-sdk'
import type { McpClient } from './client.ts'
import type { McpTool } from './protocol.ts'
import { McpError, renderResult } from './protocol.ts'

/**
 * Somebody else's tools, as ours.
 *
 * This is the whole point of the bridge: an MCP server already knows how to
 * talk to Linear, Sentry, a database, a browser. Rewriting each of those as a
 * plugin would be work with no end, and every one of them would be a worse
 * version of something that already exists.
 *
 * Nothing about MCP reaches the agent loop. What comes out here is a `Tool`,
 * indistinguishable from `read` or `bash` — which is the test of whether the
 * tool contract was the right shape.
 */

/**
 * How a bridged tool is named.
 *
 * Prefixed because two servers may both offer `search`, and because a name
 * that says where a tool comes from is the difference between a transcript
 * you can read and one you cannot. The separator is a double underscore
 * rather than a dot: several providers only accept `[A-Za-z0-9_-]` in a
 * function name, and a dot is rejected by all of them.
 */
export function bridgedName(server: string, tool: string): string {
  return `mcp__${sanitise(server)}__${sanitise(tool)}`
}

function sanitise(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, '_')
}

/** An empty object schema, for a tool that declared none. */
const NO_ARGUMENTS = { type: 'object', properties: {} }

export function bridgeTool(client: McpClient, tool: McpTool): Tool {
  return {
    name: bridgedName(client.name, tool.name),
    description: tool.description ?? `The ${tool.name} tool, from the ${client.name} server.`,
    // Passed through as the server wrote it. A schema we rewrote would be a
    // schema the server did not agree to, and the server is the one that has
    // to accept the arguments.
    inputSchema: tool.inputSchema ?? NO_ARGUMENTS,

    async execute(input: unknown, context: ToolContext): Promise<ToolOutput> {
      try {
        const result = await client.callTool(tool.name, input ?? {}, context.signal)
        return {
          content: renderResult(result),
          // A tool that failed on the server's side is a failed tool call, not
          // a failed turn: the model is told and can try something else.
          ...(result.isError === true ? { isError: true } : {}),
        }
      } catch (cause) {
        if (cause instanceof McpError) return { content: cause.message, isError: true }
        return {
          content: `${client.name}: ${cause instanceof Error ? cause.message : String(cause)}`,
          isError: true,
        }
      }
    },
  }
}

/** Every tool a connected server offers. */
export function bridgeTools(client: McpClient): Tool[] {
  return client.tools.map((tool) => bridgeTool(client, tool))
}

/**
 * The connected servers, as a plugin.
 *
 * Built at run time rather than written down, because what a server offers is
 * only known once it has been asked — but it goes through `definePlugin` and
 * the same registry as everything else. A privileged registration path for
 * "our own" capabilities is exactly what this project claims not to have.
 */
export function createMcpPlugin(clients: McpClient[]): Plugin {
  return definePlugin({
    name: 'mcp-bridge',
    tools: clients.flatMap((client) => bridgeTools(client)),
  })
}
