/**
 * A plugin written the way a stranger would write one.
 *
 * It uses every part of the contract that used to be reachable only from
 * inside this repository: settings from the project config, a credential
 * named rather than pasted, a question put to the person at the keyboard, a
 * directory of its own, and a hook. Nothing here imports anything private.
 *
 * To try it:
 *
 *     mkdir -p .aidcrew/plugins && cp -r examples/plugin-with-setup .aidcrew/plugins/standup
 *     aidcrew plugin check .aidcrew/plugins/standup
 *     aidcrew plugin trust standup
 *
 * and add to .aidcrew/config.toml:
 *
 *     [plugins.standup]
 *     team = "core"
 *     tokenEnv = "STANDUP_TOKEN"
 */

import { defineHooks, definePlugin, defineTool, type PluginHost } from '@aidcrew/plugin-sdk'
import { z } from 'zod'

const Settings = z.object({
  /** Which team's notes to write. */
  team: z.string().default('everyone'),
  /**
   * The *name* of the variable holding the token, never the token.
   *
   * The config file is committed, so a key written into it is a key published.
   * The host refuses one that looks like a credential; this is the other half.
   */
  tokenEnv: z.string().optional(),
})

export default definePlugin({
  name: 'standup',

  setup: async (host: PluginHost) => {
    const parsed = Settings.safeParse(host.config)
    if (!parsed.success) {
      // Thrown from setup, so the plugin does not load and the person is told
      // why — rather than loading and misbehaving quietly.
      throw new Error(`standup: ${parsed.error.issues.map((one) => one.message).join('; ')}`)
    }
    const settings = parsed.data
    const token = settings.tokenEnv ? process.env[settings.tokenEnv] : undefined

    // Somewhere of its own, under the user's directory rather than the
    // project's, so a cache does not turn up in somebody's diff.
    const notes = `${await host.stateDir()}/notes.md`

    if (settings.tokenEnv && !token) {
      // Not signed: the harness puts the name on it, so every plugin's news
      // reads the same way and one cannot sign another's.
      host.say?.(`${settings.tokenEnv} is not set, so notes stay local.`)
    }

    return {
      tools: [
        defineTool({
          name: 'standup_note',
          description:
            'Records one line about what was just finished, for the team standup. Use after ' +
            'completing a piece of work, not while planning it.',
          schema: z.object({ line: z.string().min(1) }),
          run: async ({ line }) => {
            const entry = `- [${settings.team}] ${line}\n`
            await Bun.write(
              notes,
              (await Bun.file(notes)
                .text()
                .catch(() => '')) + entry,
            )
            return { content: `noted in ${notes}` }
          },
        }),
      ],

      hooks: defineHooks({
        preToolCall: async (call) => {
          // A question put to the person, which no third-party plugin could
          // ask before `setup` existed. Absent means nobody is watching, and
          // an unattended run agrees to nothing it was not already told.
          if (call.name !== 'standup_note' || !host.ask) return undefined
          const allowed = await host.ask({
            title: 'Write a standup note?',
            detail: `It goes to ${notes}`,
          })
          return allowed ? undefined : { content: 'the note was not written', isError: false }
        },
      }),
    }
  },
})
