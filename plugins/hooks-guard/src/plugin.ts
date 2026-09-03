import type { Hooks, Plugin, ToolCallInfo, ToolContext, ToolOutput } from '@aidcrew/core'
import { defineHooks, definePlugin } from '@aidcrew/plugin-sdk'
import { irreversible } from './irreversible.ts'
import { refuseWrite } from './protected.ts'
import { commit, discard, type Snapshot, snapshot } from './undo.ts'

/**
 * The guards that make an agent safe enough to leave alone.
 *
 * Three of them, and they answer three different questions. What is never
 * allowed at all — a short list of files whose loss is unrecoverable or a
 * security incident. What always has to be asked about — a handful of shell
 * commands that cannot be taken back, which stay asked about however trusting
 * the mode. And what can simply be undone — every write and edit, because a
 * change you can reverse does not need to be prevented.
 *
 * All of it is a plugin. None of it is in the core, and removing this plugin
 * leaves a harness that runs exactly as before with none of these opinions —
 * which is the test of whether the plugin contract is real.
 */

/** How much an agent is trusted, decided per agent. */
export type Trust = 'ask' | 'yolo'

export type GuardOptions = {
  /** How much each agent is trusted; anything unnamed is asked about. */
  trust(agentId: string): Trust
  /** Asks a person. Absent for headless runs, where refusing is the only answer. */
  ask?(request: GuardRequest): Promise<boolean>
  /** Off for a run that must not touch the disk more than it already is. */
  snapshots?: boolean
  now?(): number
}

export type GuardRequest = {
  agentId: string
  tool: string
  summary: string
  because: string
  /** True when no amount of trust skips this one. */
  always: boolean
}

/** Tools that change something outside this process. */
const CHANGES_THINGS = new Set(['write', 'edit'])

export function createGuard(options: GuardOptions): Hooks {
  const now = options.now ?? (() => Date.now())
  /**
   * Copies taken for calls that have not finished yet, by call id.
   *
   * The bytes have to be kept before the tool writes, but whether there is a
   * change to record is only known after it has: an edit whose oldString is
   * not found changes nothing, and recording it anyway made it the newest
   * entry — so the next undo put back a file that had not moved, and the
   * change that had actually been made stayed.
   */
  const taken = new Map<string, Snapshot>()

  return defineHooks({
    async preToolCall(call: ToolCallInfo, context: ToolContext): Promise<ToolOutput | undefined> {
      const input = (call.input ?? {}) as Record<string, unknown>

      if (CHANGES_THINGS.has(call.name)) {
        const path = typeof input.path === 'string' ? input.path : ''
        const refusal = refuseWrite(path, context.cwd)
        // Refused whatever the mode: trusting an agent to work unattended is
        // not the same as letting it rewrite the repository or the keys.
        if (refusal) {
          return {
            content: `refused: ${refusal.path} cannot be written because ${refusal.because}`,
            isError: true,
          }
        }

        if (options.snapshots !== false && path !== '') {
          taken.set(call.id, snapshot(context.cwd, path, context.agentId, now()))
        }
        return undefined
      }

      if (call.name !== 'bash') return undefined

      const command = typeof input.command === 'string' ? input.command : ''
      const danger = irreversible(command)
      if (!danger) return undefined

      // Asked about even in yolo, and approving one never approves the next:
      // "stop asking me" is a statement about routine work, and none of these
      // are routine.
      const allowed = await options.ask?.({
        agentId: context.agentId,
        tool: 'bash',
        summary: command,
        because: danger.what,
        always: true,
      })

      return allowed
        ? undefined
        : { content: `not approved: this command ${danger.what}`, isError: true }
    },

    async postToolCall(call: ToolCallInfo, output: ToolOutput): Promise<ToolOutput | undefined> {
      const pending = taken.get(call.id)
      if (!pending) return undefined
      taken.delete(call.id)

      if (output.isError) discard(pending)
      else commit(pending)
      return undefined
    },
  })
}

/**
 * The guards as a plugin, which is how they reach the loop.
 *
 * A factory rather than a value because the guards need to know who is trusted
 * and who to ask, and that is a property of the session rather than of the
 * plugin. `tool-skills` does the same thing for the same reason: a plugin that
 * needs configuration is built when the configuration is known, and is
 * registered like any other.
 *
 * Nothing wires these hooks in by hand. If this plugin is not registered, none
 * of these opinions apply — which is the point.
 */
export function createGuardPlugin(options: GuardOptions): Plugin {
  return { name: 'hooks-guard', version: '0.0.0', hooks: createGuard(options) }
}

export default definePlugin({
  name: 'hooks-guard',
  version: '0.0.0',
})
