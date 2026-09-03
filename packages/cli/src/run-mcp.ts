import { join } from 'node:path'
import type { DeclaredServer } from '@aidcrew/mcp-bridge'
import {
  connectAll,
  describeServer,
  type McpClient,
  readServers,
  transportFor,
} from '@aidcrew/mcp-bridge'
import type { SettingsStore } from './store.ts'

/**
 * Seeing and trusting MCP servers.
 *
 * Trust is given here, by typing a command, rather than through a prompt that
 * appears while you are doing something else. An MCP server is a program run
 * on this machine, declared by a file that arrives with a repository — so the
 * decision deserves the two seconds it takes to read what it would run, and a
 * prompt in the middle of a task is a prompt answered without reading.
 */

export type McpIo = {
  write(text: string): void
  writeError(text: string): void
}

export function mcpFilesFor(cwd: string, home: string): string[] {
  return [
    join(home, '.aidcrew', 'mcp.json'),
    join(cwd, '.mcp.json'),
    join(cwd, '.aidcrew', 'mcp.json'),
  ]
}

export function trustKey(workspace: string, name: string): string {
  return `mcp.trust.${workspace}.${name}`
}

export async function runMcp(
  rest: string[],
  store: SettingsStore,
  io: McpIo,
  cwd: string,
  home: string,
): Promise<number> {
  const [action, target] = rest
  const { servers, problems } = await readServers(mcpFilesFor(cwd, home))

  for (const problem of problems) io.writeError(`${problem}\n`)

  if (action === undefined || action === 'list') {
    return list(servers, store, io, cwd)
  }

  if (action === 'trust' || action === 'revoke') {
    if (target === undefined) {
      io.writeError(`aidcrew mcp ${action} <server>\n`)
      return 1
    }

    const server = servers.find((entry) => entry.name === target)
    if (!server) {
      io.writeError(
        `no server called "${target}" is declared. Declared: ${
          servers.map((entry) => entry.name).join(', ') || 'none'
        }\n`,
      )
      return 1
    }

    store.set(trustKey(cwd, target), action === 'trust' ? 'allow' : 'refuse')
    io.write(
      action === 'trust'
        ? `${target} may now start in this workspace (${describeServer(server.spec)})\n`
        : `${target} will not be started in this workspace\n`,
    )
    return 0
  }

  if (action === 'check') return await check(servers, store, io, cwd)

  io.writeError(`unknown: mcp ${action}. Try list, trust, revoke or check.\n`)
  return 1
}

function list(servers: DeclaredServer[], store: SettingsStore, io: McpIo, cwd: string): number {
  if (servers.length === 0) {
    io.write('no MCP servers declared. Put them in .mcp.json, as any other tool reads it.\n')
    return 0
  }

  for (const server of servers) {
    const decision = store.get(trustKey(cwd, server.name))
    // The state comes first because it is what the reader is looking for, and
    // "not trusted" has to be as visible as a server that is running.
    const state =
      decision === 'allow' ? 'trusted  ' : decision === 'refuse' ? 'refused  ' : 'untrusted'
    io.write(`  ${state} ${server.name.padEnd(16)} ${describeServer(server.spec)}\n`)
  }

  const untrusted = servers.filter((server) => store.get(trustKey(cwd, server.name)) !== 'allow')
  if (untrusted.length > 0) {
    io.write(
      `\n${untrusted.length} not started. A server is a program this file asks to run;\n` +
        `read what it runs, then: aidcrew mcp trust ${untrusted[0]?.name}\n`,
    )
  }
  return 0
}

/** Connects to the trusted servers and says what each one actually offers. */
async function check(
  servers: DeclaredServer[],
  store: SettingsStore,
  io: McpIo,
  cwd: string,
): Promise<number> {
  const trusted = servers.filter((server) => store.get(trustKey(cwd, server.name)) === 'allow')
  if (trusted.length === 0) {
    io.writeError('no trusted servers to check\n')
    return 1
  }

  const { connected, failed } = await connectAll(trusted, cwd, new AbortController().signal)

  for (const client of connected) {
    io.write(`  ${client.name} — ${client.tools.length} tools\n`)
    for (const tool of client.tools) {
      io.write(`      ${tool.name.padEnd(28)} ${(tool.description ?? '').split('\n')[0] ?? ''}\n`)
    }
    await client.close()
  }
  for (const failure of failed) io.writeError(`  ${failure.name} — ${failure.reason}\n`)

  return failed.length > 0 ? 1 : 0
}

/** Whether a server may run, as `createHost` asks it. Never asks anybody. */
export function trustedServers(store: SettingsStore, cwd: string) {
  return (server: DeclaredServer): boolean => store.get(trustKey(cwd, server.name)) === 'allow'
}

/** Kept for the type export; a client is opened per check and closed after. */
export type { McpClient }
export { transportFor }
