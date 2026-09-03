import type { PluginCandidate, PluginLoadFailure } from '@aidcrew/core'
import { PluginRegistry } from '@aidcrew/core'
import { fillRegistry, type Host, type HostOptions } from './host.ts'

/**
 * Reads the plugin directories again, into the running host.
 *
 * The README has promised "no build step, no publishing, no restart" since the
 * first day, and two of the three were true. This is the third: a tool you add
 * is offered on the next turn, a hook you change applies to the next call, and
 * an edit that breaks a plugin removes it rather than leaving the version you
 * have stopped believing in running behind your back.
 *
 * The registry is rebuilt from scratch rather than added to, because a plugin
 * that was deleted has to actually go away — and because registering the same
 * tool twice is refused, which is the correct behaviour and exactly wrong for
 * a reload.
 */
export async function reloadPlugins(
  host: Host,
  options: HostOptions,
): Promise<{
  failures: PluginLoadFailure[]
  refused: PluginCandidate[]
  warnings: PluginLoadFailure[]
}> {
  const rebuilt = new PluginRegistry()
  const { failures, refused, warnings } = await fillRegistry(rebuilt, options, true)

  host.registry.replaceWith(rebuilt)
  host.failures.splice(0, host.failures.length, ...failures)
  host.refused.splice(0, host.refused.length, ...refused)
  host.warnings.splice(0, host.warnings.length, ...warnings)

  return { failures, refused, warnings }
}
