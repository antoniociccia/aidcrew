import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { Plugin, PluginCandidate } from '@aidcrew/core'
import { suppliedBy, validatePlugin, warningsFor } from '@aidcrew/core'
import { serveHostModules } from './host.ts'
import type { SettingsStore } from './store.ts'
import { loadWorkspaceConfig, WorkspaceConfigError } from './workspace.ts'

/**
 * `aidcrew plugin` — what this project offers, and whether it may run.
 *
 * A plugin is code that runs in this process with the filesystem, the network
 * and every API key on the machine. One that arrived with a repository is a
 * stranger's code, and cloning a repository must not be enough to run it —
 * which is the shape of every supply-chain incident there has ever been.
 *
 * Deliberately the same shape and the same words as `aidcrew mcp`, for the
 * strictly less dangerous case of a program in another process. Trust given
 * by typing it, never by a prompt in the middle of something else: a question
 * that interrupts is a question answered without reading.
 */

export type PluginIo = {
  write(text: string): void
  writeError(text: string): void
}

export function pluginTrustKey(workspace: string, name: string): string {
  return `plugin.trust.${workspace}.${name}`
}

/** Whether a project plugin may run here, for the host to consult. */
export function trustedPlugins(store: SettingsStore, cwd: string) {
  return (candidate: PluginCandidate): boolean =>
    candidate.scope !== 'project' || store.get(pluginTrustKey(cwd, candidate.name)) === 'allow'
}

/** The plugin directories this project offers, without importing any of them. */
export async function offeredPlugins(cwd: string): Promise<string[]> {
  try {
    const entries = await readdir(join(cwd, '.aidcrew', 'plugins'), { withFileTypes: true })
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
  } catch {
    return []
  }
}

export async function runPlugins(
  rest: string[],
  store: SettingsStore,
  io: PluginIo,
  cwd: string,
  home: string,
): Promise<number> {
  const [action, target] = rest
  const offered = await offeredPlugins(cwd)

  if (action === undefined || action === 'list') {
    return list(offered, store, io, cwd)
  }

  if (action === 'check') {
    // Against the working directory, not the process's idea of one: in a
    // compiled binary a bare relative specifier resolves against the bundle.
    return await check(target === undefined ? cwd : resolve(cwd, target), io, cwd, home)
  }

  if (action === 'trust' || action === 'revoke') {
    if (target === undefined) {
      io.writeError(`aidcrew plugin ${action} <name>\n`)
      return 1
    }
    // Refused rather than remembered: a typo stored forever would sit in the
    // list looking trusted while the real plugin is still refused.
    if (!offered.includes(target)) {
      io.writeError(
        `this project offers no plugin called "${target}"` +
          (offered.length > 0 ? `. It offers: ${offered.join(', ')}\n` : '\n'),
      )
      return 1
    }

    store.set(pluginTrustKey(cwd, target), action === 'trust' ? 'allow' : 'refuse')
    io.write(
      action === 'trust'
        ? `"${target}" will run in this project from the next start.\n`
        : `"${target}" will not run here.\n`,
    )
    return 0
  }

  io.writeError('aidcrew plugin [list|check <dir>|trust <name>|revoke <name>]\n')
  return 1
}

/**
 * Loads one plugin the way the host would, and says what it found.
 *
 * The same validator, so what this prints before you ship is verbatim what
 * the host says when it loads. A checker that is merely similar to the loader
 * is a checker people stop believing. That is why setup is given this
 * project's `[plugins.<name>]` table rather than nothing: a plugin refused
 * here and loaded happily by `aidcrew` in the same directory teaches its
 * author to stop running this.
 */
async function check(directory: string, io: PluginIo, cwd: string, home: string): Promise<number> {
  // The same modules the host offers, or a plugin written the documented way
  // fails here and nowhere else.
  serveHostModules()

  const entry = ['index.ts', 'plugin.ts', 'index.js', 'plugin.js']
    .map((name) => join(directory, name))
    .find((candidate) => existsSync(candidate))

  if (!entry) {
    io.writeError(
      `no plugin in ${directory}: expected an index.ts, plugin.ts, index.js or plugin.js\n`,
    )
    return 1
  }

  let module: { default?: unknown }
  try {
    module = (await import(entry)) as { default?: unknown }
  } catch (cause) {
    io.writeError(
      `${entry} did not load: ${cause instanceof Error ? cause.message : String(cause)}\n`,
    )
    return 1
  }

  const problem = validatePlugin(module.default)
  if (problem) {
    io.writeError(`${problem}\n`)
    return 1
  }

  let plugin = module.default as Plugin

  // Set up, because a plugin whose whole capability comes from setup would
  // otherwise be reported as supplying nothing — which is worse than saying
  // nothing at all.
  if (plugin.setup) {
    const outcome = await build(plugin, directory, cwd, home, io)
    if ('problem' in outcome) {
      io.writeError(outcome.problem)
      return 1
    }
    plugin = outcome.plugin
  }

  // On the plugin as it will be registered, and so after the whole of setup
  // rather than inside it, or one with no setup stops being warned about at
  // all. A capability misspelled in what setup returns is precisely what
  // these warnings are for, and nothing else here would catch it.
  for (const warning of warningsFor(plugin)) io.write(`  warning: ${warning}\n`)

  const supplies = suppliedBy(plugin)
  io.write(`"${plugin.name}" is a valid plugin.\n`)
  io.write(
    supplies.length > 0
      ? `It supplies ${supplies.join(', ')}.\n`
      : 'It supplies nothing, which is legal and probably not what you meant.\n',
  )
  return 0
}

/**
 * What a plugin becomes once it is set up here, or what to say instead.
 *
 * The settings are this project's own `[plugins.<name>]` table, because the
 * host would give it those and a checker that gives it something else is a
 * checker that fails a plugin the host loads happily. A project that declares
 * no table for it leaves the old promise standing: a plugin has to survive on
 * a machine that has never heard of it.
 */
async function build(
  plugin: Plugin,
  directory: string,
  cwd: string,
  home: string,
  io: PluginIo,
): Promise<{ plugin: Plugin } | { problem: string }> {
  let declared: Record<string, unknown> | undefined
  try {
    declared = (await loadWorkspaceConfig({ cwd, home })).plugins[plugin.name]
  } catch (cause) {
    // What setup builds is decided by what the config says, so a config this
    // cannot read makes everything said after it a guess.
    if (!(cause instanceof WorkspaceConfigError)) throw cause
    return { problem: `${cause.message}\n` }
  }

  let built: Plugin
  try {
    built = await builtElsewhere(plugin, directory, declared ?? {}, io)
  } catch (cause) {
    const said = cause instanceof Error ? cause.message : String(cause)
    return {
      problem: declared
        ? `${plugin.name}: setup failed on the settings in [plugins.${plugin.name}]: ${said}\n`
        : `${plugin.name}: setup failed with no settings: ${said}\n` +
          'If it needs configuring, that is expected — try it in a project with its ' +
          `[plugins.${plugin.name}] table filled in.\n`,
    }
  }

  // The same validator, because what setup returns is as capable of being the
  // wrong shape as what the module exported — and more likely to be, since it
  // was built rather than written.
  const problem = validatePlugin(built)
  return problem ? { problem: `${problem}\n` } : { plugin: built }
}

/**
 * Runs a plugin's `setup` the way the loader does, but nowhere near the work.
 *
 * The loader gives a plugin a state directory under the user's own, because a
 * cache keyed to a plugin has no business turning up in somebody's diff. A
 * checker has the sharper version of that problem: it is pointed at code
 * nobody has decided to trust yet, so what that code writes goes to a
 * directory thrown away when this returns — never the user's own, and never
 * the checkout it was asked to inspect.
 *
 * What it says goes into the report. Every host that loads a plugin gives it
 * a way to speak, and a plugin explaining while it is set up that the variable
 * holding its token is empty is telling the author the one thing they ran this
 * to find out. `ask` is the other half and is deliberately absent: nobody is
 * watching a check, and that is the answer the contract already gives.
 */
async function builtElsewhere(
  plugin: Plugin,
  directory: string,
  config: unknown,
  io: PluginIo,
): Promise<Plugin> {
  const elsewhere = await mkdtemp(join(tmpdir(), 'aidcrew-check-'))
  try {
    const extra = await plugin.setup?.({
      cwd: directory,
      home: elsewhere,
      config,
      say: (text: string) => io.write(`  ${plugin.name}: ${text}\n`),
      stateDir: async () => {
        const path = join(elsewhere, '.aidcrew', 'plugin-state', plugin.name)
        await mkdir(path, { recursive: true })
        return path
      },
      signal: new AbortController().signal,
    })
    return extra ? { ...plugin, ...extra } : plugin
  } finally {
    await rm(elsewhere, { recursive: true, force: true })
  }
}

function list(offered: string[], store: SettingsStore, io: PluginIo, cwd: string): number {
  if (offered.length === 0) {
    io.write('no plugins in this project (.aidcrew/plugins).\n')
    return 0
  }

  io.write('plugins this project offers:\n\n')
  for (const name of offered) {
    const decision = store.get(pluginTrustKey(cwd, name))
    const state =
      decision === 'allow' ? 'trusted' : decision === 'refuse' ? 'refused' : 'not trusted'
    io.write(`  ${name.padEnd(24)} ${state}\n`)
  }
  io.write('\nA plugin runs in this process, with your keys. Trust one with:\n')
  io.write('  aidcrew plugin trust <name>\n')
  return 0
}
