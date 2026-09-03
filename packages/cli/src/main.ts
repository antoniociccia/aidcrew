#!/usr/bin/env bun
import { homedir } from 'node:os'
import type { AgentDef, Hooks, LoopResult, Message, Tool } from '@aidcrew/core'
import { runAgentLoop } from '@aidcrew/core'
import { createSkillsPlugin, renderSkillIndex } from '@aidcrew/tool-skills'
import type { CliArgs } from './args.ts'
import { parseCliArgs, USAGE, UsageError } from './args.ts'
import type { Config } from './config.ts'
import { ConfigError, loadConfig, providerOptions } from './config.ts'
import { keyForProvider } from './credentials.ts'
import type { Host } from './host.ts'
import { createHost, createProvider, ProviderNotFoundError } from './host.ts'
import { buildSystemPrompt } from './prompt.ts'
import { createRenderer } from './render.ts'
import { ConfigUsageError, runConfig } from './run-config.ts'
import { demoIntro, demoOutro, demoPlugin, plantDemoProject } from './run-demo.ts'
import { runForget } from './run-forget.ts'
import { runKeys } from './run-keys.ts'
import { runMcp, trustedServers } from './run-mcp.ts'
import { ModelsError, runModels } from './run-models.ts'
import { runPlugins, trustedPlugins } from './run-plugins.ts'
import { refusalLine, runProject, trustedClaims } from './run-project.ts'
import { MissingCredentialError, NoTeamError, runTeam } from './run-team.ts'
import { runUndo } from './run-undo.ts'
import { collectSources } from './sources.ts'
import type { SettingsStore } from './store.ts'
import { openStore } from './store.ts'
import { VERSION } from './version.ts'
import type { WorkspaceConfig } from './workspace.ts'
import { loadWorkspaceConfig, WorkspaceConfigError } from './workspace.ts'

export type MainIo = {
  write(text: string): void
  writeError(text: string): void
  color: boolean
}

export type MainOptions = {
  /** Overrides where plugins are searched. Used by the tests. */
  pluginDirs?: string[]
  /** Overrides the home directory. Used by the tests. */
  home?: string
  /** The settings store; opened by the entry point, injected by tests. */
  store?: SettingsStore
}

/**
 * One headless run, returning the process exit code.
 *
 * Kept free of `process` so it can be driven end to end from a test.
 */
export async function main(
  argv: string[],
  env: Record<string, string | undefined>,
  io: MainIo,
  signal: AbortSignal,
  options: MainOptions = {},
): Promise<number> {
  try {
    const args = parseCliArgs(argv)
    if (args.help) {
      io.write(`${USAGE}\n`)
      return 0
    }

    if (args.version) {
      io.write(`${VERSION}\n`)
      return 0
    }

    // One store for every command, opened here rather than per command: the
    // run needs the saved provider, model and key just as much as `config`
    // needs to write them.
    return await withStore(options, async (store) => {
      if (args.command === 'config') {
        return await runConfig(args.rest, store, { ...io, readSecret })
      }

      if (args.command === 'undo') {
        return await runUndo(args.rest, io, args.cwd)
      }

      if (args.command === 'keys') {
        return await runKeys(io, process.stdin)
      }

      if (args.command === 'mcp') {
        return await runMcp(args.rest, store, io, args.cwd, options.home ?? homedir())
      }

      if (args.command === 'plugin') {
        return await runPlugins(args.rest, store, io, args.cwd, options.home ?? homedir())
      }

      if (args.command === 'forget') {
        return await runForget(store, io, options.home ?? homedir())
      }

      if (args.command === 'demo') {
        return await runDemo(args, io, signal, options)
      }

      if (args.command === 'project') {
        return await runProject(args.rest, store, io, args.cwd, options.home ?? homedir())
      }

      if (args.command === 'models') {
        const host = await createHost({
          cwd: args.cwd,
          ...(options.pluginDirs ? { pluginDirs: options.pluginDirs } : {}),
          ...(options.home ? { home: options.home } : {}),
        })
        return await runModels(args.rest, host, store, env, io, args.cwd)
      }

      if (args.command === 'ui') {
        // Imported here so a headless run never loads React at all.
        const { startInterface } = await import('@aidcrew/tui')
        return await startInterface({
          cwd: args.cwd,
          ...(options.home ? { home: options.home } : {}),
          env,
        })
      }

      const session = await prepare(args, env, io, { ...options, store })

      return args.command === 'team'
        ? await runTeam(args, env, io, signal, session)
        : await runOne(args, io, signal, session)
    })
  } catch (error) {
    // Usage, configuration and provider problems are the user's to fix and
    // need no stack trace; anything else is a bug and gets one.
    if (
      error instanceof UsageError ||
      error instanceof ConfigError ||
      error instanceof ProviderNotFoundError ||
      error instanceof WorkspaceConfigError ||
      error instanceof NoTeamError ||
      error instanceof MissingCredentialError ||
      error instanceof MissingKeyError ||
      error instanceof ConfigUsageError ||
      error instanceof ModelsError
    ) {
      io.writeError(`${error.message}\n`)
      return 2
    }
    io.writeError(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`)
    return 1
  }
}

/** One agent, one instruction. */
async function runOne(
  args: CliArgs,
  io: MainIo,
  signal: AbortSignal,
  session: Session,
): Promise<number> {
  const messages: Message[] = [{ role: 'user', content: [{ type: 'text', text: args.prompt }] }]

  const run = runAgentLoop({
    provider: session.provider,
    model: session.model,
    system: session.system,
    tools: session.tools,
    messages,
    maxTurns: args.maxTurns,
    cwd: args.cwd,
    // Named even alone: the guards record who changed what, and an empty name
    // makes the record read as though nobody had.
    agentId: 'agent',
    signal,
    hooks: session.hooks,
  })

  const renderer = createRenderer({ write: io.write, color: io.color })
  let result: LoopResult

  for (;;) {
    const step = await run.next()
    if (step.done) {
      result = step.value
      break
    }
    renderer.handle(step.value)
  }

  renderer.finish()

  if (result.stopReason === 'max_turns') {
    io.writeError(`stopped after ${result.turns} turns without finishing\n`)
    return 1
  }
  if (result.stopReason === 'aborted') {
    io.writeError('interrupted\n')
    return 130
  }
  return 0
}

/**
 * The key for a single-agent run, from the same places a team uses.
 * Refusing here, before any request, beats a 401 after the first turn.
 */
function resolveKey(
  providerId: string,
  env: Record<string, string | undefined>,
  store?: SettingsStore,
): Record<string, unknown> {
  const resolved = keyForProvider(providerId, { env, ...(store ? { store } : {}) })
  if (!resolved) {
    throw new MissingKeyError(providerId)
  }
  return {
    apiKey: resolved.apiKey,
    ...(resolved.baseUrl ? { baseUrl: resolved.baseUrl } : {}),
  }
}

export class MissingKeyError extends Error {
  override readonly name = 'MissingKeyError'

  constructor(providerId: string) {
    super(`no key for provider "${providerId}". Add one in Settings.`)
  }
}

type Session = {
  provider: ReturnType<typeof createProvider>
  model: string
  system: string
  tools: Tool[]
  hooks: Hooks[]
  /** Kept for the team command, which needs the agents and their overrides. */
  host: Host
  workspace: WorkspaceConfig
  agents: AgentDef[]
  agentSources: Map<string, string>
  /** This user's own directory, which is where a reusable crew is kept. */
  home: string
  config: Config
  store?: SettingsStore
}

/**
 * Everything that has to happen before the first request: load the plugins,
 * read the project's sources, build the prompt and the provider.
 *
 * Failures that leave the agent less capable than the user believes — a plugin
 * that would not load, a source that would not parse — are announced rather
 * than swallowed.
 */
async function prepare(
  args: CliArgs,
  env: Record<string, string | undefined>,
  io: MainIo,
  options: MainOptions,
): Promise<Session> {
  const store = options.store
  const config = loadConfig(env, store)
  // Read before the host, because a plugin's setup is handed its own settings
  // while the host is being built.
  const settings = await loadWorkspaceConfig({
    cwd: args.cwd,
    home: options.home ?? homedir(),
    // The config file arrived with the clone too. Without this, a repository
    // could hand an agent a licence to act unasked, or name a file outside
    // the project to read into every request, and nothing here would notice.
    ...(store ? { trusted: trustedClaims(store, args.cwd) } : {}),
  })

  const host = await createHost({
    cwd: args.cwd,
    ...(options.pluginDirs ? { pluginDirs: options.pluginDirs } : {}),
    ...(options.home ? { home: options.home } : {}),
    // Only the servers somebody has trusted in this workspace. Nothing is
    // asked here: there is no one to ask, and a run with nobody watching
    // starting a program a cloned file named is the thing to avoid.
    ...(store ? { allowServer: trustedServers(store, args.cwd) } : {}),
    // The same answer for a plugin, which is more dangerous still: it runs in
    // this process rather than beside it. Given by typing `aidcrew plugin
    // trust <name>`, never by a prompt in the middle of a run.
    ...(store ? { allowPlugin: trustedPlugins(store, args.cwd) } : {}),
    // The same settings the interface passes. A plugin that behaves
    // differently under `-p` is a plugin whose bugs only appear in CI.
    setup: {
      configFor: (name: string) => settings.plugins[name] ?? {},
      say: (plugin: string, text: string) => io.writeError(`${plugin}: ${text}\n`),
    },
  })

  // First, because it is the one with something to do about it.
  for (const refusal of settings.refused) io.writeError(`${refusalLine(refusal)}\n`)

  for (const failure of host.failures) {
    io.writeError(`plugin not loaded (${failure.path}): ${failure.reason}\n`)
  }
  // Beside the plugins that did not load, for the same reason. A server that
  // was not started is a set of tools the model was never offered; the
  // interface says so next to the transcript, and this path said nothing — a
  // CI job watched a model fail to call tools it did not have, with no line
  // saying why.
  for (const failure of host.serverFailures) {
    io.writeError(`MCP server "${failure.name}": ${failure.reason}\n`)
  }
  for (const warning of host.warnings) {
    io.writeError(`${warning.reason}\n`)
  }
  for (const candidate of host.refused) {
    io.writeError(
      `plugin "${candidate.name}" is not running: it came with this project and runs with your ` +
        `keys. "aidcrew plugin trust ${candidate.name}" if you want it.\n`,
    )
  }

  const workspace = settings
  const sources = await collectSources(host.registry.loaders(), workspace.sources)
  for (const failure of sources.failures) {
    io.writeError(`source not loaded (${failure.path}): ${failure.reason}\n`)
  }

  // Registered after loading, because it serves the skills actually found on
  // this machine — and not at all when there are none: a tool the model can
  // never usefully call still costs tokens in every request of every turn.
  if (sources.skills.length > 0) {
    host.registry.register(createSkillsPlugin(sources.skills))
  }

  return {
    host,
    workspace,
    agents: sources.agents,
    agentSources: sources.agentSources,
    // So a crew kept in ~/.aidcrew/agents is on the team without the project
    // having to name it, the way one kept in the project itself is.
    home: options.home ?? homedir(),
    config,
    ...(store ? { store } : {}),
    provider: createProvider(host, config.providerId, {
      ...resolveKey(config.providerId, env, store),
      ...providerOptions(config.providerId, env, store),
    }),
    model: config.model,
    system: buildSystemPrompt({
      cwd: args.cwd,
      platform: process.platform,
      instructions: sources.instructions.map((instruction) => instruction.text),
      skillIndex: renderSkillIndex(sources.skills),
    }),
    tools: host.registry.tools(),
    hooks: host.registry
      .plugins()
      .map((plugin) => plugin.hooks)
      .filter((hook): hook is Hooks => hook !== undefined),
  }
}

/**
 * Reads a secret without echoing it.
 *
 * Piped input is read whole, so a key can come from a password manager. At a
 * terminal the echo is turned off, because a key typed in plain sight ends up
 * in screen recordings and over shoulders.
 */
async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    return await Bun.stdin.text()
  }

  process.stderr.write(prompt)
  process.stdin.setRawMode(true)
  process.stdin.resume()

  try {
    return await readLineSilently()
  } finally {
    process.stdin.setRawMode(false)
    process.stdin.pause()
    process.stderr.write('\n')
  }
}

/** Enter ends it; Ctrl-C abandons it rather than saving half a key. */
async function readLineSilently(): Promise<string> {
  let typed = ''

  for await (const chunk of process.stdin) {
    for (const byte of chunk as Uint8Array) {
      if (byte === 13 || byte === 10) return typed
      if (byte === 3) throw new Error('cancelled')
      typed = byte === 127 || byte === 8 ? typed.slice(0, -1) : typed + String.fromCharCode(byte)
    }
  }

  return typed
}

/** Opens the store when the caller did not supply one, and closes what it opened. */
async function withStore<T>(
  options: MainOptions,
  use: (store: SettingsStore) => Promise<T>,
): Promise<T> {
  if (options.store) return await use(options.store)

  const store = openStore(options.home ?? homedir())
  try {
    return await use(store)
  } finally {
    store.close()
  }
}

/**
 * The process: arguments in, exit code out, streams flushed on the way.
 *
 * Called from bin.ts and from nowhere else. It used to sit behind
 * `import.meta.main` here, which a compiled binary on Windows answers false —
 * the paths compared do not match — so the binary started, ran nothing,
 * printed nothing and exited 0, and the release job read an empty version.
 * A file that does nothing but call this cannot be skipped.
 */
export async function run(): Promise<never> {
  const controller = new AbortController()
  process.on('SIGINT', () => controller.abort())

  const code = await main(
    process.argv.slice(2),
    process.env,
    {
      write: (text) => process.stdout.write(text),
      writeError: (text) => process.stderr.write(text),
      color: process.stdout.isTTY === true,
    },
    controller.signal,
  )

  // process.exit drops whatever the streams have not flushed yet. On Windows,
  // with stdout on a pipe, that was the whole of `--version`: the release job
  // captured nothing and refused the binary. An empty write with a callback
  // is queued behind everything written so far, so waiting on it is waiting
  // for the lot.
  await Promise.all(
    [process.stdout, process.stderr].map(
      (stream) => new Promise<void>((flushed) => stream.write('', () => flushed())),
    ),
  )
  process.exit(code)
}

/**
 * The demo: a real bug, real tools, the real loop, and a model that is not.
 *
 * It builds its own session rather than going through `prepare`, because
 * `prepare` reads the project's config and this project has none — and
 * because the one thing that must not be real here is the provider, which is
 * the only field it overrides.
 */
async function runDemo(
  args: CliArgs,
  io: MainIo,
  signal: AbortSignal,
  options: MainOptions,
): Promise<number> {
  const repo = await plantDemoProject()
  io.write(demoIntro(repo))

  const host = await createHost({
    cwd: repo,
    ...(options.pluginDirs ? { pluginDirs: options.pluginDirs } : {}),
    ...(options.home ? { home: options.home } : {}),
    // Nothing this project offers is trusted, because nothing was offered:
    // the directory was made a moment ago and holds three files.
    mcpFiles: [],
  })
  host.registry.register(demoPlugin())

  const code = await runOne(
    { ...args, cwd: repo, prompt: 'the check fails, fix it', maxTurns: 12 },
    io,
    signal,
    {
      provider: createProvider(host, 'demo', {}),
      model: 'demo',
      system: buildSystemPrompt({ cwd: repo, platform: process.platform, instructions: [] }),
      tools: host.registry.tools(),
      hooks: host.registry
        .plugins()
        .map((plugin) => plugin.hooks)
        .filter((hook): hook is Hooks => hook !== undefined),
      host,
      workspace: { sources: { instructions: [], skills: [], agents: [] } } as never,
      agents: [],
      agentSources: new Map(),
      home: options.home ?? homedir(),
      config: {} as never,
    },
  )

  const fixed = Bun.spawnSync(['./check.sh'], { cwd: repo }).exitCode === 0
  io.write(demoOutro(repo, fixed))
  // The demo is a claim about the harness, so a demo that did not work is a
  // failure of the harness and says so with its exit code too.
  return code === 0 && fixed ? 0 : 1
}
