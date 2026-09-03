import type { Plugin } from './types.ts'

/**
 * What a plugin must look like, checked before it is trusted to work.
 *
 * The shape check used to cover `name`, `tools` and `providers`, which is
 * three of six. The gap mattered more than the count: `tools`, `providers`,
 * `prices` and `loaders` are all arrays and `hooks` is a single object, so
 * `hooks: [myHooks]` is the natural mistake — and it loads clean, registers,
 * appears in the settings screen, and then never runs, because the registry
 * reads `plugin.hooks?.preToolCall` off an array and finds nothing. A
 * permission guard that is installed, listed, and absent is the worst thing
 * this contract can produce.
 *
 * Hand-written rather than schema-driven, to keep the core free of runtime
 * dependencies: this is a handful of shape checks on a module the user has
 * already decided to trust, not the parsing of hostile input.
 */

/**
 * The version of this contract, and the oldest one still understood.
 *
 * Without this, nothing tells a plugin and a host that they disagree: when
 * the contract changes, an old plugin either half-works or fails at its first
 * call, which is what a public API removed in a patch release with no
 * deprecation does to everything built on it. A refusal that names both
 * numbers is the difference between an ecosystem that survives a change and
 * one that quietly rots.
 *
 * The policy, which is the part that matters: capabilities are only ever
 * added within a contract, a field never changes meaning without a bump, and
 * there is one release of overlap.
 */
export const CONTRACT = 1

/** The oldest a plugin may declare and still load. */
export const OLDEST_CONTRACT = 1

/** Capabilities that are lists, and the singular somebody will type instead. */
const LISTS = ['tools', 'providers', 'prices', 'loaders'] as const

/** Every key a plugin may carry, for spotting the ones nobody will read. */
const KNOWN = new Set([
  ...LISTS,
  'name',
  'version',
  'description',
  'contract',
  'hooks',
  'ui',
  'setup',
])

export function validatePlugin(value: unknown): string | undefined {
  if (value === undefined || value === null) return 'module has no default export'
  if (typeof value !== 'object') return `default export is a ${typeof value}, expected an object`

  const plugin = value as Record<string, unknown>
  if (typeof plugin.name !== 'string' || plugin.name === '') {
    return 'default export has no "name"'
  }
  const named = `plugin "${plugin.name}"`

  if (plugin.contract !== undefined) {
    if (typeof plugin.contract !== 'number' || !Number.isInteger(plugin.contract)) {
      return `${named}: "contract" must be a whole number, the plugin contract it was written against`
    }
    if (plugin.contract > CONTRACT) {
      return (
        `${named} was written against contract ${plugin.contract}; this aidcrew understands ` +
        `${CONTRACT}. Update aidcrew, or install a version of the plugin built for it.`
      )
    }
    if (plugin.contract < OLDEST_CONTRACT) {
      return (
        `${named} was written against contract ${plugin.contract}, which is no longer supported ` +
        `(the oldest is ${OLDEST_CONTRACT}). Rebuild it against a current @aidcrew/plugin-sdk.`
      )
    }
  }

  for (const key of LISTS) {
    const held = plugin[key]
    if (held !== undefined && !Array.isArray(held)) {
      return `${named}: "${key}" must be an array`
    }
  }

  if (plugin.hooks !== undefined) {
    if (Array.isArray(plugin.hooks)) {
      return `${named}: "hooks" must be an object, not an array — one plugin has one set of hooks`
    }
    if (typeof plugin.hooks !== 'object' || plugin.hooks === null) {
      return `${named}: "hooks" must be an object`
    }
  }

  if (plugin.setup !== undefined && typeof plugin.setup !== 'function') {
    return `${named}: "setup" must be a function (host) => capabilities`
  }

  if (plugin.ui !== undefined) {
    const ui = plugin.ui as { render?: unknown }
    if (typeof ui !== 'object' || ui === null || typeof ui.render !== 'function') {
      return `${named}: "ui" must be an object with a "render" function`
    }
  }

  const problem = checkTools(plugin, named) ?? checkProviders(plugin, named)
  if (problem) return problem

  return undefined
}

/**
 * What is odd about a plugin without being wrong.
 *
 * A key nobody reads is silence with a typo in it — `tool:` for `tools:` is
 * one letter and a plugin that loads, registers and contributes nothing. But
 * it is not a reason to refuse the plugin: somebody may be carrying metadata
 * of their own, and refusing it would be the harness deciding what a stranger
 * is allowed to put in their own object.
 */
export function warningsFor(value: unknown): string[] {
  if (typeof value !== 'object' || value === null) return []

  const plugin = value as Record<string, unknown>
  const named = typeof plugin.name === 'string' ? `plugin "${plugin.name}"` : 'plugin'

  return Object.keys(plugin)
    .filter((key) => !KNOWN.has(key))
    .map((key) => {
      const meant = [...KNOWN].find((known) => known === `${key}s` || `${known}s` === key)
      return meant
        ? `${named}: "${key}" is not a capability — did you mean "${meant}"? Nothing reads "${key}".`
        : `${named}: nothing reads "${key}".`
    })
}

function checkTools(plugin: Record<string, unknown>, named: string): string | undefined {
  for (const [at, entry] of ((plugin.tools ?? []) as unknown[]).entries()) {
    const tool = entry as { name?: unknown; execute?: unknown; description?: unknown }
    const where = `${named}: tools[${at}]`
    if (typeof tool?.name !== 'string' || tool.name === '') return `${where} has no "name"`
    if (typeof tool.description !== 'string' || tool.description === '') {
      return `${where} ("${tool.name}") has no "description" — it is what the model reads before choosing it`
    }
    if (typeof tool.execute !== 'function') {
      return `${where} ("${tool.name}") has no "execute" function`
    }
  }
  return undefined
}

function checkProviders(plugin: Record<string, unknown>, named: string): string | undefined {
  for (const [at, entry] of ((plugin.providers ?? []) as unknown[]).entries()) {
    const provider = entry as { id?: unknown; create?: unknown }
    const where = `${named}: providers[${at}]`
    if (typeof provider?.id !== 'string' || provider.id === '') return `${where} has no "id"`
    if (typeof provider.create !== 'function') {
      return `${where} ("${provider.id}") has no "create" function`
    }
  }
  return undefined
}

/** What a plugin actually contributes, read off the object rather than claimed. */
export function suppliedBy(plugin: Plugin): string[] {
  const has: string[] = []
  if (plugin.tools?.length)
    has.push(`${plugin.tools.length} tool${plugin.tools.length > 1 ? 's' : ''}`)
  if (plugin.providers?.length)
    has.push(`${plugin.providers.length} provider${plugin.providers.length > 1 ? 's' : ''}`)
  if (plugin.prices?.length) has.push('prices')
  if (plugin.loaders?.length) has.push('loaders')
  if (plugin.hooks) has.push(`hooks (${Object.keys(plugin.hooks).join(', ')})`)
  if (plugin.ui) has.push('ui')
  return has
}
