import { homedir } from 'node:os'
import { join } from 'node:path'
import type {
  Plugin,
  PluginCandidate,
  PluginLoadFailure,
  PluginSource,
  Provider,
  SetupOptions,
} from '@aidcrew/core'
import * as core from '@aidcrew/core'
import { loadPluginsFrom, PluginRegistry, serveToPlugins } from '@aidcrew/core'
import type { GuardOptions } from '@aidcrew/hooks-guard'
import { createGuardPlugin } from '@aidcrew/hooks-guard'
import claudeLoaderPlugin from '@aidcrew/loader-claude'
import type { DeclaredServer, McpClient } from '@aidcrew/mcp-bridge'
import { connectAll, createMcpPlugin, readServers } from '@aidcrew/mcp-bridge'
import * as sdk from '@aidcrew/plugin-sdk'
import { retrying } from '@aidcrew/plugin-sdk'
import pricesPlugin from '@aidcrew/prices'
import anthropic from '@aidcrew/provider-anthropic'
import gemini from '@aidcrew/provider-gemini'
import openAiCompat from '@aidcrew/provider-openai-compat'
import bashPlugin from '@aidcrew/tool-bash'
import dataPlugin from '@aidcrew/tool-data'
import fsPlugin from '@aidcrew/tool-fs'
import gitPlugin from '@aidcrew/tool-git'
import headPlugin from '@aidcrew/tool-head'
import outlinePlugin from '@aidcrew/tool-outline'
import searchPlugin from '@aidcrew/tool-search'
import statPlugin from '@aidcrew/tool-stat'
import treePlugin from '@aidcrew/tool-tree'
import unixPlugin from '@aidcrew/tool-unix'
import * as zod from 'zod'

/**
 * Plugins shipped with the package.
 *
 * They are imported statically so the binary works with an empty plugin
 * directory, but they go through the same registry as anything a user writes.
 * If this contract were not enough to express them, the contract would be
 * wrong — which is why the four tools and every provider live out here rather
 * than inside the core.
 */
const BUNDLED: Plugin[] = [
  fsPlugin,
  bashPlugin,
  searchPlugin,
  treePlugin,
  headPlugin,
  statPlugin,
  dataPlugin,
  outlinePlugin,
  gitPlugin,
  unixPlugin,
  openAiCompat,
  anthropic,
  gemini,
  claudeLoaderPlugin,
  pricesPlugin,
]

export class ProviderNotFoundError extends Error {
  override readonly name = 'ProviderNotFoundError'

  constructor(id: string, available: string[]) {
    super(
      `unknown provider "${id}". Available: ${available.join(', ')}. ` +
        'Add one by dropping a plugin in ~/.aidcrew/plugins, or use "openai-compat" ' +
        'with AIDCREW_BASE_URL for any endpoint that speaks the OpenAI dialect.',
    )
  }
}

export type Host = {
  registry: PluginRegistry
  /** Plugins that could not be loaded; reported, never fatal. */
  failures: PluginLoadFailure[]
  /** Plugins the project offered that nobody has allowed to run. */
  refused: PluginCandidate[]
  /** Loaded, but with something in them nothing will ever read. */
  warnings: PluginLoadFailure[]
  /** MCP servers this host is connected to, so they can be closed at the end. */
  servers: McpClient[]
  /** Servers that were declared and could not be reached, with why. */
  serverFailures: { name: string; reason: string }[]
}

export type HostOptions = {
  /** Extra directories to search. Defaults to the user and project plugin dirs. */
  pluginDirs?: PluginSource[]
  /**
   * What each plugin's `setup` is given: its own settings, and a way to reach
   * the person at the keyboard.
   *
   * Absent means setup runs with defaults — the project directory, no
   * settings, nobody to ask — which is right for a headless run.
   */
  setup?: Partial<SetupOptions>
  /**
   * Whether a plugin that came with the project may run.
   *
   * Asked before it is imported, because after the import its top-level code
   * has already run with this process's keys. Absent means no: the same
   * answer `allowServer` gives twenty lines below, for the strictly less
   * dangerous case of a program in another process.
   */
  allowPlugin?(candidate: PluginCandidate): boolean | Promise<boolean>
  home?: string
  cwd?: string
  /**
   * How the guards behave for this host.
   *
   * Registered here rather than by each caller, because a caller that forgets
   * runs with no protected files, no pause on a command that cannot be taken
   * back, and no copy of anything before it changes — and one did, silently,
   * for as long as the guards have existed.
   *
   * The default suits a run with nobody watching: nothing can be asked, so
   * anything that would have been asked about is refused.
   */
  guard?: GuardOptions
  /**
   * Files declaring MCP servers, most general first.
   *
   * Absent means the usual pair: the user's own, then the project's. An empty
   * list means none, which is what the tests want and what a run with no
   * business starting other programs wants.
   */
  mcpFiles?: string[]
  /**
   * Whether a declared server may be started.
   *
   * A `.mcp.json` in a cloned repository is a list of programs somebody else
   * chose, and cloning a repository must not run them. The default answer is
   * no for exactly that reason: a caller that wants them has to say so, and
   * the interface asks a person before it does.
   */
  allowServer?(server: DeclaredServer): boolean | Promise<boolean>
}

/**
 * Builds the registry: bundled plugins first, then whatever the user installed.
 *
 * Only explicitly configured directories are read. Nothing is fetched and
 * nothing is installed — a plugin runs with full access to the machine and to
 * the API keys, so putting one on disk is the act of trust, and it is the
 * user's to make.
 */
/**
 * Where plugins are read from, for a host and for every later reload.
 *
 * One function rather than the same two joins in two places: they drifted
 * once already, and a reload that reads a different directory from the load
 * is a reload that silently removes everything.
 */
export function pluginDirectoriesFor(options: HostOptions): PluginSource[] {
  return (
    options.pluginDirs ?? [
      // The user's own, which needs no permission: they decided when they put
      // the file there. The project's, which does: it arrived with a clone.
      { path: join(options.home ?? homedir(), '.aidcrew', 'plugins'), scope: 'user' },
      { path: join(options.cwd ?? process.cwd(), '.aidcrew', 'plugins'), scope: 'project' },
    ]
  )
}

/** The plugins that ship, plus the guards, which every path must have. */
export function bundledPlugins(options: HostOptions = {}): Plugin[] {
  return [...BUNDLED, createGuardPlugin(options.guard ?? { trust: () => 'ask' })]
}

/**
 * Hands the host's own modules to whatever is about to import a plugin.
 *
 * A plugin lives where nothing has ever been installed, so
 * `import { definePlugin } from '@aidcrew/plugin-sdk'` — the first line of
 * every example ever written for this project — used to fail with "Cannot
 * find module". These are the copies already inside the binary, made
 * resolvable by name. Anything that loads a plugin has to call this first,
 * which is why it is exported rather than buried in createHost: `plugin
 * check` loads one too, and a checker that cannot import what the host can is
 * a checker that fails on working plugins.
 */
export function serveHostModules(): void {
  serveToPlugins({
    '@aidcrew/plugin-sdk': sdk,
    '@aidcrew/core': core,
    // Because every schema in every example is a zod schema, and a plugin
    // author should not have to vendor the validator the host already uses:
    // two copies of zod is also two `instanceof` checks that disagree.
    zod,
  })
}

export async function createHost(options: HostOptions = {}): Promise<Host> {
  serveHostModules()

  const registry = new PluginRegistry()
  const { failures, refused, warnings } = await fillRegistry(registry, options, false)

  const { servers, serverFailures } = await attachServers(options, registry, failures)

  return { registry, failures, refused, warnings, servers, serverFailures }
}

/**
 * Puts the bundled plugins and then the user's into a registry.
 *
 * Shared by the first load and by every reload, so what a reload ends up with
 * cannot differ from what starting up would have produced.
 */
export async function fillRegistry(
  registry: PluginRegistry,
  options: HostOptions,
  fresh: boolean,
): Promise<{
  failures: PluginLoadFailure[]
  refused: PluginCandidate[]
  warnings: PluginLoadFailure[]
}> {
  for (const plugin of bundledPlugins(options)) registry.register(plugin)

  const result = await loadPluginsFrom(pluginDirectoriesFor(options), {
    fresh,
    ...(options.allowPlugin ? { allow: options.allowPlugin } : {}),
    setup: {
      cwd: options.cwd ?? process.cwd(),
      home: options.home ?? homedir(),
      ...options.setup,
    },
  })
  const failures = [...result.failed]

  for (const plugin of result.loaded) {
    try {
      registry.register(plugin)
    } catch (cause) {
      // A conflicting plugin is skipped, not fatal: the bundled ones still work.
      failures.push({
        path: result.sources.get(plugin.name) ?? plugin.name,
        reason: cause instanceof Error ? cause.message : String(cause),
      })
    }
  }

  return { failures, refused: result.refused, warnings: result.warnings }
}

/**
 * Connects the MCP servers this workspace declares and registers their tools.
 *
 * Registered as a plugin like anything else, built at run time rather than
 * written down: what a server offers is only known once it has been asked. The
 * agent loop never learns that any of this happened — it sees tools.
 */
async function attachServers(
  options: HostOptions,
  registry: PluginRegistry,
  failures: PluginLoadFailure[],
): Promise<{ servers: McpClient[]; serverFailures: { name: string; reason: string }[] }> {
  const cwd = options.cwd ?? process.cwd()
  const files = options.mcpFiles ?? [
    join(options.home ?? homedir(), '.aidcrew', 'mcp.json'),
    join(cwd, '.mcp.json'),
    join(cwd, '.aidcrew', 'mcp.json'),
  ]

  const { servers: declared, problems } = await readServers(files)
  for (const problem of problems) failures.push({ path: 'mcp', reason: problem })
  if (declared.length === 0) return { servers: [], serverFailures: [] }

  const allowed: DeclaredServer[] = []
  const refused: { name: string; reason: string }[] = []
  for (const server of declared) {
    const permitted = (await options.allowServer?.(server)) ?? false
    if (permitted) allowed.push(server)
    else refused.push({ name: server.name, reason: `not started: ${server.from} is not trusted` })
  }

  if (allowed.length === 0) return { servers: [], serverFailures: refused }

  const { connected, failed } = await connectAll(allowed, cwd, new AbortController().signal)

  if (connected.length > 0) registry.register(createMcpPlugin(connected))

  return { servers: connected, serverFailures: [...refused, ...failed] }
}

export function createProvider(host: Host, id: string, config: Record<string, unknown>): Provider {
  const definition = host.registry.provider(id)
  if (!definition) {
    throw new ProviderNotFoundError(
      id,
      host.registry.providers().map((p) => p.id),
    )
  }
  // Wrapped here rather than by each provider, so a service that is briefly
  // unavailable does not end an agent's turn — and so the next provider
  // written gets it without knowing to ask. The flag it acts on is one every
  // provider already sets and nothing has ever read.
  return retrying(definition.create(config))
}
