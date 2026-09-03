import type { Dirent } from 'node:fs'
import { mkdir, readdir, stat } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { validatePlugin, warningsFor } from './contract.ts'
import type { Plugin, PluginHost } from './types.ts'

/** Entry points looked for inside a plugin directory, in order. */
const ENTRY_POINTS = ['index.ts', 'plugin.ts', 'index.js', 'plugin.js']

export type PluginLoadFailure = {
  path: string
  reason: string
}

export type PluginLoadResult = {
  loaded: Plugin[]
  failed: PluginLoadFailure[]
  /** Plugin name to the directory it came from. */
  sources: Map<string, string>
  /** Plugins that were found and not run, because nobody had allowed them. */
  refused: PluginCandidate[]
  /** Things worth saying about a plugin that loaded anyway. */
  warnings: PluginLoadFailure[]
}

/**
 * A plugin directory, before anything in it has been imported.
 *
 * This is all that can be known about a plugin without running it, and it is
 * therefore all the trust decision can be based on: what it is called and
 * where it came from. Reading its source to describe it would be reading a
 * description its author wrote.
 */
export type PluginCandidate = {
  /** The directory's own name, which is the address a person trusts. */
  name: string
  path: string
  scope: PluginScope
}

/**
 * Whose decision a directory represents.
 *
 * `user` is somebody's own plugin directory: the decision was made when they
 * put the file there, and asking again would only train them to say yes.
 * `project` arrived with a repository — cloning one must not be enough to run
 * its code, which is the shape of every supply-chain incident there has been.
 */
export type PluginScope = 'user' | 'project'

/** A directory to read, and whose it is. A bare string means `user`. */
export type PluginSource = string | { path: string; scope: PluginScope }

/**
 * Discovers and imports plugins from the given directories.
 *
 * A plugin is arbitrary code running with the host's full authority, including
 * access to API keys, so this loader only ever reads the paths it was handed:
 * it never fetches from a URL and never installs anything. Deciding which
 * directories are trusted is the host's job, made once and recorded in config.
 *
 * A broken plugin is reported and skipped rather than thrown, because one bad
 * third-party directory should not stop the agent from starting.
 */
/** What a plugin's `setup` needs, minus the parts the loader fills in. */
export type SetupOptions = {
  cwd: string
  home: string
  /** This plugin's own settings, by plugin name. */
  configFor?(name: string): unknown
  /**
   * Puts a plugin's question to whoever is watching, saying whose it is.
   *
   * The name is carried because a question cannot be answered without it:
   * "may I use the token in your keychain?" is a different decision depending
   * on which plugin is asking, and the one drawing the prompt has no other
   * way to know. It is bound here rather than passed by the plugin, so a
   * plugin cannot claim to be another one.
   */
  ask?(plugin: string, question: { title: string; detail?: string }): Promise<boolean>
  /** A plugin's news, with its name, so nobody has to write their own. */
  say?(plugin: string, text: string): void
  signal?: AbortSignal
}

export type LoadOptions = {
  /**
   * What to hand a plugin's `setup`, if it has one.
   *
   * Absent means setup is not called at all — which is right for the places
   * that only want to look at a plugin, like `aidcrew plugin check`.
   */
  setup?: SetupOptions

  /**
   * Whether a plugin from a project may run, asked BEFORE it is imported.
   *
   * After the import is too late: a module's top-level code has already run,
   * with this process's filesystem access, its network and its API keys, so a
   * question put afterwards is theatre. Absent means no, because an
   * unattended run must not start something nobody chose.
   */
  allow?(candidate: PluginCandidate): boolean | Promise<boolean>

  /**
   * Read the files again rather than reusing what was imported before.
   *
   * Bun caches a module by path, so a plain second import of an edited plugin
   * returns the old one. A reload that silently does nothing is worse than no
   * reload: you edit, you save, you see the old behaviour, and you blame your
   * edit. Off by default, because the cache is right every other time.
   */
  fresh?: boolean
}

/** Bumped on every fresh load, so each one imports under a name of its own. */
let generation = 0

export async function loadPluginsFrom(
  directories: PluginSource[],
  options: LoadOptions = {},
): Promise<PluginLoadResult> {
  const result: PluginLoadResult = {
    loaded: [],
    failed: [],
    sources: new Map(),
    refused: [],
    warnings: [],
  }
  if (options.fresh === true) generation += 1

  // Each plugin directory once, however many times it was named. The user
  // directory and the project directory are the same directory whenever
  // somebody opens their home as a project, and reading it twice made every
  // plugin in it a duplicate of itself — refused with the memorable message
  // `plugin "live" is provided by both "live" and "live"`.
  const seen = new Set<string>()

  for (const source of directories) {
    const { path, scope } =
      typeof source === 'string' ? { path: source, scope: 'user' as const } : source

    for (const directory of await pluginDirectories(path)) {
      if (seen.has(directory)) continue
      seen.add(directory)

      const candidate: PluginCandidate = { name: basename(directory), path: directory, scope }
      if (scope === 'project' && !(await (options.allow?.(candidate) ?? false))) {
        result.refused.push(candidate)
        continue
      }

      await loadOne(
        directory,
        result,
        options.fresh === true ? generation : undefined,
        options.setup,
      )
    }
  }

  return result
}

/** Subdirectories of `directory`, sorted, so hook order never depends on the filesystem. */
async function pluginDirectories(directory: string): Promise<string[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(directory, { withFileTypes: true })
  } catch {
    // A configured directory that does not exist yet is simply empty.
    return []
  }

  return (
    entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      // Resolved, so two spellings of one directory — `~/x` and `~/x/.`, or a
      // relative path and its absolute form — are recognised as the same one.
      .map((name) => resolve(directory, name))
  )
}

async function loadOne(
  directory: string,
  result: PluginLoadResult,
  generation?: number,
  setup?: SetupOptions,
): Promise<void> {
  const entry = await findEntryPoint(directory)
  if (!entry) return

  // A query the module system has never seen is a module it has never loaded.
  // This is how a plugin gets reloaded; the files it imports in turn are
  // cached still, which is why a reload is offered per plugin directory
  // rather than promised for everything a plugin touches.
  const specifier = generation === undefined ? entry : `${entry}?aidcrew=${generation}`

  let module: { default?: unknown }
  try {
    module = (await import(specifier)) as { default?: unknown }
  } catch (cause) {
    result.failed.push({ path: directory, reason: explain(cause) })
    return
  }

  const problem = validatePlugin(module.default)
  if (problem) {
    result.failed.push({ path: directory, reason: problem })
    return
  }

  let plugin = module.default as Plugin
  if (plugin.setup && setup) {
    try {
      plugin = await built(plugin, setup)
    } catch (cause) {
      result.failed.push({ path: directory, reason: explain(cause) })
      return
    }

    // The same validator, because what setup returns is as capable of being
    // the wrong shape as what the module exported — and more likely to be,
    // since it was built rather than written.
    const built_problem = validatePlugin(plugin)
    if (built_problem) {
      result.failed.push({ path: directory, reason: built_problem })
      return
    }
  }
  for (const reason of warningsFor(plugin)) result.warnings.push({ path: directory, reason })
  result.loaded.push(plugin)
  result.sources.set(plugin.name, directory)
}

/**
 * Runs a plugin's `setup` and merges what it returns over what it declared.
 *
 * Merged rather than replaced, so a plugin can declare the tools it always
 * has and build only the parts that need to know something first.
 */
async function built(plugin: Plugin, options: SetupOptions): Promise<Plugin> {
  const host: PluginHost = {
    cwd: options.cwd,
    home: options.home,
    config: options.configFor?.(plugin.name) ?? {},
    // Bound to this plugin's name on the way in. The plugin passes a
    // question; who is asking is not its to say.
    ...(options.ask ? { ask: (question) => askIt(options, plugin.name, question) } : {}),
    ...(options.say ? { say: (text: string) => options.say?.(plugin.name, text) } : {}),
    stateDir: async () => {
      // Under the user's directory, not the project's: a cache keyed to a
      // plugin has no business turning up in somebody's diff.
      const path = join(options.home, '.aidcrew', 'plugin-state', plugin.name)
      await mkdir(path, { recursive: true })
      return path
    },
    signal: options.signal ?? new AbortController().signal,
  }

  const extra = await plugin.setup?.(host)
  return extra ? { ...plugin, ...extra } : plugin
}

/**
 * What went wrong, in the words the author needs.
 *
 * A build failure arrives as an AggregateError whose own message is a count —
 * "3 errors building index.ts" — with the actual complaints inside `.errors`.
 * "3 errors" is not something anybody can act on, and this is the very first
 * thing that happens to a person writing their first plugin.
 */
function explain(cause: unknown): string {
  if (!(cause instanceof Error)) return String(cause)

  const inner = (cause as { errors?: unknown }).errors
  if (Array.isArray(inner) && inner.length > 0) {
    const said = inner
      .slice(0, MOST_ERRORS_SHOWN)
      .map((one) => (one instanceof Error ? one.message : String(one)))
    const rest = inner.length - said.length
    return said.join('; ') + (rest > 0 ? ` (and ${rest} more)` : '')
  }

  return cause.message
}

/** Enough to see the shape of the mistake, not enough to fill the screen. */
const MOST_ERRORS_SHOWN = 3

async function findEntryPoint(directory: string): Promise<string | undefined> {
  for (const name of ENTRY_POINTS) {
    const candidate = join(directory, name)
    try {
      if ((await stat(candidate)).isFile()) return candidate
    } catch {
      // Not this one; try the next.
    }
  }
  return undefined
}

/** Narrows the optional asker, so the bound one above stays a one-liner. */
async function askIt(
  options: SetupOptions,
  name: string,
  question: { title: string; detail?: string },
): Promise<boolean> {
  return (await options.ask?.(name, question)) ?? false
}
