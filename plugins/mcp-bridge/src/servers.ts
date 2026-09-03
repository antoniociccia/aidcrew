import { z } from 'zod'
import type { Transport } from './client.ts'
import { McpClient } from './client.ts'
import { createHttpTransport } from './http.ts'
import { createStdioTransport } from './stdio.ts'

/**
 * Where servers are declared, and the decision about whether to run them.
 *
 * The file format is `.mcp.json` as everybody else writes it — the same file a
 * project already has for another tool, read where it lies rather than
 * imported. A project that has one works here with no setup at all.
 *
 * Which is exactly why starting them cannot be automatic. A `.mcp.json` in a
 * cloned repository is a list of programs somebody else chose, and cloning a
 * repository must not run them. So a server declared by a project is not
 * started until a person has said it may be, and that answer is remembered.
 */

const StdioServer = z.object({
  command: z.string().min(1),
  args: z.array(z.string()).optional(),
  env: z.record(z.string(), z.string()).optional(),
  type: z.literal('stdio').optional(),
})

const HttpServer = z.object({
  url: z.url({ protocol: /^https?$/ }),
  headers: z.record(z.string(), z.string()).optional(),
  type: z.enum(['http', 'sse', 'streamable-http']).optional(),
})

const ServerSpec = z.union([StdioServer, HttpServer])

const McpFile = z.object({
  mcpServers: z.record(z.string(), ServerSpec).optional(),
  // Some files use `servers` instead. Both are read, since a file that is
  // nearly right should not silently produce a team with no tools.
  servers: z.record(z.string(), ServerSpec).optional(),
})

export type ServerSpec = z.infer<typeof ServerSpec>

export type DeclaredServer = {
  name: string
  spec: ServerSpec
  /** The file it came from, so a question about it can say where to look. */
  from: string
}

/** Reads every server declared in the given files. Missing files are empty. */
export async function readServers(paths: string[]): Promise<{
  servers: DeclaredServer[]
  problems: string[]
}> {
  const servers: DeclaredServer[] = []
  const problems: string[] = []
  const seen = new Set<string>()

  for (const path of paths) {
    const file = Bun.file(path)
    if (!(await file.exists())) continue

    let raw: unknown
    try {
      raw = await file.json()
    } catch (cause) {
      problems.push(`${path} is not valid JSON: ${cause instanceof Error ? cause.message : cause}`)
      continue
    }

    const parsed = McpFile.safeParse(raw)
    if (!parsed.success) {
      problems.push(`${path}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`)
      continue
    }

    const declared = { ...parsed.data.servers, ...parsed.data.mcpServers }
    for (const [name, spec] of Object.entries(declared)) {
      // First declaration wins, and the files are given most-specific last —
      // so a project can override a server the user declared globally.
      if (seen.has(name)) {
        servers[servers.findIndex((server) => server.name === name)] = { name, spec, from: path }
        continue
      }
      seen.add(name)
      servers.push({ name, spec, from: path })
    }
  }

  return { servers, problems }
}

export function transportFor(server: DeclaredServer, cwd: string): Transport {
  if ('url' in server.spec) {
    return createHttpTransport(server.name, {
      url: server.spec.url,
      ...(server.spec.headers ? { headers: server.spec.headers } : {}),
    })
  }

  return createStdioTransport(server.name, {
    command: server.spec.command,
    ...(server.spec.args ? { args: server.spec.args } : {}),
    ...(server.spec.env ? { env: server.spec.env } : {}),
    cwd,
  })
}

export type ConnectResult = {
  connected: McpClient[]
  /** Servers that could not be reached, with why, so it can be said out loud. */
  failed: { name: string; reason: string }[]
}

/**
 * Connects to every server, in parallel, and never lets one failure matter.
 *
 * A server that is not installed, or whose token expired, is a normal Tuesday.
 * Refusing to start the whole team over it would make the bridge a liability;
 * saying which one failed and carrying on is what a person would do.
 */
export async function connectAll(
  servers: DeclaredServer[],
  cwd: string,
  signal: AbortSignal,
): Promise<ConnectResult> {
  const results = await Promise.all(
    servers.map(async (server) => {
      const client = new McpClient(server.name, transportFor(server, cwd))
      try {
        await client.connect(signal)
        return { client }
      } catch (cause) {
        await client.close().catch(() => {})
        return {
          failure: {
            name: server.name,
            reason: cause instanceof Error ? cause.message : String(cause),
          },
        }
      }
    }),
  )

  return {
    connected: results.flatMap((result) => ('client' in result ? [result.client] : [])),
    failed: results.flatMap((result) => ('failure' in result ? [result.failure] : [])),
  }
}
