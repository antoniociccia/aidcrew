/**
 * Whether a declared server may be started.
 *
 * An MCP server is a program, usually somebody else's, run on this machine
 * with whatever the file says. A `.mcp.json` arrives with a repository, so
 * cloning a repository and opening it would otherwise be enough to run it —
 * which is the shape of every supply-chain incident there has ever been.
 *
 * The answer is therefore no until a person says otherwise, once per server
 * per workspace, and it is remembered. Remembering matters as much as asking:
 * a question repeated every morning is a question answered without reading.
 */

export type TrustStore = {
  get(key: string): string | undefined
  set(key: string, value: string): void
}

export type TrustDecision = 'allow' | 'refuse'

export type TrustOptions = {
  workspace: string
  store: TrustStore
  /**
   * Asks a person. Absent means nobody is watching, which is itself an
   * answer: an unattended run starts nothing it was not already told to.
   */
  ask?(question: { name: string; from: string; what: string }): Promise<TrustDecision>
}

/** What a server would do, in one line, for the question that gets asked. */
export function describe(spec: unknown): string {
  const server = spec as { command?: string; args?: string[]; url?: string }
  if (server.url) return `connects to ${server.url}`
  return `runs ${[server.command, ...(server.args ?? [])].join(' ')}`
}

function keyFor(workspace: string, name: string): string {
  return `mcp.trust.${workspace}.${name}`
}

/**
 * The decision for one server, asked once and then remembered.
 *
 * Keyed by workspace as well as by name, because "linear" in one project is
 * not the same declaration as "linear" in another: the name is the part that
 * is easy to reuse, and the command is the part that matters.
 */
export function createTrust(options: TrustOptions) {
  return async function allow(server: {
    name: string
    from: string
    spec: unknown
  }): Promise<boolean> {
    const key = keyFor(options.workspace, server.name)
    const remembered = options.store.get(key)
    if (remembered === 'allow') return true
    if (remembered === 'refuse') return false

    if (!options.ask) return false

    const decision = await options.ask({
      name: server.name,
      from: server.from,
      what: describe(server.spec),
    })

    options.store.set(key, decision)
    return decision === 'allow'
  }
}
