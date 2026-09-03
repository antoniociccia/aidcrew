import type { Tool } from '../loop.ts'
import type { Loader } from '../sources/types.ts'
import type {
  HookName,
  Hooks,
  Plugin,
  PriceSource,
  ProviderDefinition,
  UiContext,
  UiSegment,
} from './types.ts'

/** Two plugins claimed the same name, tool name or provider id. */
export class DuplicateCapabilityError extends Error {
  override readonly name = 'DuplicateCapabilityError'

  constructor(
    readonly kind: 'plugin' | 'tool' | 'provider',
    readonly id: string,
    readonly owner: string,
    readonly claimant: string,
  ) {
    // Two plugins of the same name have the same name, which is the whole
    // problem: `plugin "live" is provided by both "live" and "live"` is a
    // true sentence that helps nobody work out what to do next.
    super(
      owner === claimant && kind === 'plugin'
        ? `plugin "${id}" is already registered. Two directories hold a plugin of that name, ` +
            'or the same directory is being read twice'
        : `${kind} "${id}" is provided by both "${owner}" and "${claimant}"`,
    )
  }
}

/**
 * What the host knows about the plugins it loaded.
 *
 * Conflicts are refused rather than resolved: if two plugins claim the same
 * tool name, keeping one silently would make the agent's behaviour depend on
 * load order, which is the hardest kind of bug to notice. Hooks are the
 * exception — they compose, so every one of them is kept.
 */
export class PluginRegistry {
  readonly #plugins: Plugin[] = []
  readonly #tools = new Map<string, { tool: Tool; from: string }>()
  readonly #providers = new Map<string, { provider: ProviderDefinition; from: string }>()

  /**
   * Takes on everything another registry holds, dropping what this one had.
   *
   * For reloading. The host hands this object out — the agent loop, the
   * interface and the MCP bridge all keep the same reference — so a reload
   * cannot swap in a new registry without leaving every holder looking at
   * what was there before. Rebuilt elsewhere and adopted here, so a reload
   * that fails halfway leaves the running one untouched.
   */
  replaceWith(other: PluginRegistry): void {
    this.#plugins.splice(0, this.#plugins.length, ...other.#plugins)
    this.#tools.clear()
    this.#providers.clear()
    for (const [name, entry] of other.#tools) this.#tools.set(name, entry)
    for (const [id, entry] of other.#providers) this.#providers.set(id, entry)
  }

  /**
   * Registers a plugin, or throws leaving the registry exactly as it was.
   * A half-registered plugin would be worse than a rejected one: some of its
   * tools would be live while the plugin is not.
   */
  register(plugin: Plugin): void {
    this.#assertNoConflicts(plugin)

    this.#plugins.push(plugin)
    for (const tool of plugin.tools ?? []) {
      this.#tools.set(tool.name, { tool, from: plugin.name })
    }
    for (const provider of plugin.providers ?? []) {
      this.#providers.set(provider.id, { provider, from: plugin.name })
    }
  }

  /**
   * Takes a plugin back out, with everything it brought.
   *
   * Some plugins belong to a session rather than to the program: the interface
   * builds a compactor and an approval gate around the team it is starting,
   * and both are made out of that team's agents and models. Opening a second
   * project builds them again, and this registry — quite correctly — refused
   * the second and said two directories must hold a plugin of that name.
   *
   * None did. One session was registering one name twice, and the message sent
   * whoever read it looking for a duplicate directory that does not exist.
   * What was missing was a way to say the first one is finished with.
   *
   * Everything, or the leftovers are worse than the collision: a tool still
   * answering for a plugin that is gone belongs to nobody, and the next plugin
   * of that name collides with a ghost.
   *
   * Answers whether there was one, so a caller clearing up need not look
   * first.
   */
  forget(name: string): boolean {
    const at = this.#plugins.findIndex((plugin) => plugin.name === name)
    if (at === -1) return false

    this.#plugins.splice(at, 1)
    for (const [tool, entry] of this.#tools) {
      if (entry.from === name) this.#tools.delete(tool)
    }
    for (const [id, entry] of this.#providers) {
      if (entry.from === name) this.#providers.delete(id)
    }
    return true
  }

  plugins(): readonly Plugin[] {
    return this.#plugins
  }

  tools(): Tool[] {
    return [...this.#tools.values()].map((entry) => entry.tool)
  }

  tool(name: string): Tool | undefined {
    return this.#tools.get(name)?.tool
  }

  /** Which plugin a tool came from — the first thing you want when one misbehaves. */
  sourceOfTool(name: string): string | undefined {
    return this.#tools.get(name)?.from
  }

  /** Every loader, in registration order. Loaders do not collide: several
   *  formats can describe the same kind of source. */
  /** Every price source any plugin brought, in registration order. */
  /**
   * Every price source, each contained so it cannot take the others with it.
   *
   * A price list is a convenience and never a precondition — that sentence
   * was a comment in one caller, and it is code here. One source that throws,
   * rejects, or answers with something that is not a table used to be an
   * unhandled rejection *and* the loss of every other source's prices, which
   * is a bill with no number on it because somebody's plugin had a typo.
   *
   * Contained here rather than in definePrices, because a hand-written
   * literal is legal and always will be.
   */
  prices(): PriceSource[] {
    return this.#plugins.flatMap((plugin) =>
      (plugin.prices ?? []).map((source) => ({
        ...source,
        load: async (providerId: string, config: unknown) => {
          try {
            const table = await source.load(providerId, config)
            return typeof table === 'object' && table !== null && !Array.isArray(table) ? table : {}
          } catch {
            return {}
          }
        },
      })),
    )
  }

  /**
   * Every set of hooks, with the plugin that supplied it.
   *
   * So a hook that throws can be reported against somebody: with ten plugins
   * installed, naming the hook narrows it to ten possibilities, and a plugin
   * that misbehaves is one a person can actually remove.
   */
  installedHooks(): { plugin: string; hooks: Hooks }[] {
    return this.#plugins
      .filter((plugin): plugin is Plugin & { hooks: Hooks } => plugin.hooks !== undefined)
      .map((plugin) => ({ plugin: plugin.name, hooks: plugin.hooks }))
  }

  loaders(): Loader[] {
    return this.#plugins.flatMap((plugin) => plugin.loaders ?? [])
  }

  /**
   * What every plugin wants to add to one slot of the interface.
   *
   * Each is called inside its own try: a plugin that throws while a frame is
   * being drawn costs its own segments and nothing else, because the
   * alternative is a screen that goes blank over somebody's typo. The name of
   * the plugin that failed goes to `onFailure`, since a plugin that quietly
   * draws nothing is one nobody can debug.
   */
  ui(context: UiContext, onFailure?: (plugin: string, reason: string) => void): UiSegment[] {
    const out: UiSegment[] = []

    for (const plugin of this.#plugins) {
      if (!plugin.ui) continue
      try {
        out.push(...(plugin.ui.render(context) ?? []))
      } catch (cause) {
        onFailure?.(plugin.name, cause instanceof Error ? cause.message : String(cause))
      }
    }

    return out
  }

  providers(): ProviderDefinition[] {
    return [...this.#providers.values()].map((entry) => entry.provider)
  }

  provider(id: string): ProviderDefinition | undefined {
    return this.#providers.get(id)?.provider
  }

  /** Every plugin's implementation of one hook, in registration order. */
  hooks<K extends HookName>(name: K): NonNullable<Hooks[K]>[] {
    return this.#plugins
      .map((plugin) => plugin.hooks?.[name])
      .filter((hook): hook is NonNullable<Hooks[K]> => hook !== undefined)
  }

  #assertNoConflicts(plugin: Plugin): void {
    const existing = this.#plugins.find((other) => other.name === plugin.name)
    if (existing) {
      throw new DuplicateCapabilityError('plugin', plugin.name, existing.name, plugin.name)
    }

    for (const tool of plugin.tools ?? []) {
      const owner = this.#tools.get(tool.name)
      if (owner) {
        throw new DuplicateCapabilityError('tool', tool.name, owner.from, plugin.name)
      }
    }

    for (const provider of plugin.providers ?? []) {
      const owner = this.#providers.get(provider.id)
      if (owner) {
        throw new DuplicateCapabilityError('provider', provider.id, owner.from, plugin.name)
      }
    }
  }
}
