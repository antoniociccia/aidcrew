import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import type { Hooks, Plugin, ToolCallInfo, ToolContext, ToolOutput } from '@aidcrew/core'
import { defineHooks, definePlugin } from '@aidcrew/plugin-sdk'
import { changeOf, rangesOf } from '@aidcrew/tool-fs'
import type { Collision, createRadar } from './collide.ts'
import { irreversible } from './irreversible.ts'
import { refuseWrite } from './protected.ts'
import { commit, discard, type Snapshot, snapshot, UNDO_DIR } from './undo.ts'

/**
 * The guards that make an agent safe enough to leave alone.
 *
 * Three of them, and they answer three different questions. What is never
 * allowed at all — a short list of files whose loss is unrecoverable or a
 * security incident. What has to be asked about in ask mode — shell commands
 * that cannot be taken back. Explicit yolo trust skips those prompts too.
 * And what can simply be undone — every write and edit, because a
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
  /**
   * Watches for two agents editing the same lines in two checkouts.
   *
   * Passed in rather than made here, because whoever owns the team is the one
   * who knows when a job has come home and an agent is out of the way.
   */
  radar?: ReturnType<typeof createRadar>
  /** Told about a collision, for the screen. The agents are told regardless. */
  onCollision?(hit: Collision, sentence: string): void
  now?(): number
}

export type GuardRequest = {
  agentId: string
  tool: string
  summary: string
  because: string
  /** True when ask mode requires a decision for this call rather than a remembered approval. */
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

      // Yolo is explicit permission to run tools without confirmation. A
      // second prompt here used to strand unattended cleanup in /tmp even
      // though the agent was already marked unleashed.
      if (options.trust(context.agentId) === 'yolo') return undefined

      const command = typeof input.command === 'string' ? input.command : ''
      const danger = irreversible(command)
      if (!danger) return undefined

      // In ask mode, approving one irreversible command never approves the next.
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

      if (output.isError) {
        discard(pending)
        return undefined
      }
      commit(pending)

      const radar = options.radar
      if (radar === undefined) return undefined

      const ranges = changedRanges(pending)
      if (ranges.length === 0) return undefined

      const hits = radar.saw({
        agentId: pending.change.agentId,
        path: pending.change.path,
        ranges,
        at: pending.change.at,
      })
      if (hits.length === 0) return undefined

      // Said in the result the agent is about to read, rather than in a
      // message that would arrive a turn later — by which time it has built
      // another change on top of the one that is already contested.
      const said = hits.map((hit) => {
        const sentence = radar.sentence(hit, now())
        options.onCollision?.(hit, sentence)
        return sentence
      })

      return { ...output, content: `${output.content}\n\n${said.join('\n')}` }
    },
  })
}

/**
 * Which lines of the new file a change touched.
 *
 * Worked out again here rather than carried from the tool: a hook is the one
 * place that sees every write, including those from a tool this plugin has
 * never heard of, and the bytes to compare against are already kept.
 */
function changedRanges(taken: Snapshot): [number, number][] {
  try {
    const before =
      taken.change.kept === undefined
        ? ''
        : readFileSync(join(taken.root, UNDO_DIR, taken.change.kept), 'utf8')
    const after = readFileSync(join(taken.root, taken.change.path), 'utf8')
    const change = changeOf(taken.change.path, before, after)
    return change === undefined ? [] : rangesOf(change)
  } catch {
    // A file that has since gone, or one that is not text. Neither is worth
    // failing a write that has already happened.
    return []
  }
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
