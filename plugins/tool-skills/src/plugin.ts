import { readFile } from 'node:fs/promises'
import type { Plugin, Skill } from '@aidcrew/core'
import { definePlugin, defineTool } from '@aidcrew/plugin-sdk'
import { z } from 'zod'

/**
 * Lists the available skills for the system prompt.
 *
 * Names and one-line descriptions only. Twenty skill bodies inlined would cost
 * more context than the entire base prompt, and nineteen of them would be
 * irrelevant to whatever the user just asked — so the model gets a menu and
 * fetches the one it wants.
 */
export function renderSkillIndex(skills: Skill[]): string {
  if (skills.length === 0) return ''

  const listed = skills.map((skill) => `- ${skill.name}: ${skill.description}`).join('\n')
  return `Skills available. Read one with the skill tool before doing work it covers:\n\n${listed}`
}

/**
 * Builds the plugin that serves skill bodies on demand.
 *
 * Made at runtime rather than declared statically because it closes over the
 * skills actually found on this machine, in this project.
 */
export function createSkillsPlugin(skills: Skill[]): Plugin {
  const byName = new Map(skills.map((skill) => [skill.name, skill]))

  return definePlugin({
    name: 'tool-skills',
    tools: [
      defineTool({
        name: 'skill',
        description:
          'Read the full text of one of the listed skills. Do this before work the skill covers.',
        schema: z.object({
          name: z.string().describe('The skill name, exactly as listed.'),
        }),
        async run({ name }) {
          const skill = byName.get(name)
          if (!skill) {
            const known = [...byName.keys()]
            return {
              content:
                known.length === 0
                  ? 'no skills are configured'
                  : `unknown skill "${name}". Available: ${known.join(', ')}`,
              isError: true,
            }
          }

          try {
            return { content: await readFile(skill.path, 'utf8') }
          } catch (cause) {
            // The file was there when the index was built and is not now:
            // say so plainly rather than pretending the skill is empty.
            return {
              content: `skill "${name}" could not be read: ${
                cause instanceof Error ? cause.message : String(cause)
              }`,
              isError: true,
            }
          }
        },
      }),
    ],
  })
}
