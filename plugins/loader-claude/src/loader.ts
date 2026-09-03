import { readdir, readFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { AgentDef, Instruction, Loader, Skill } from '@aidcrew/core'
import { defineLoader } from '@aidcrew/plugin-sdk'
import { listField, splitFrontmatter, stringField } from './frontmatter.ts'

/**
 * Reads the layout Claude Code and its neighbours already use: `CLAUDE.md`,
 * `AGENTS.md`, `.claude/skills/<name>/SKILL.md`, `.claude/agents/<name>.md`.
 *
 * Everything is read in place. There is no import step and nothing is copied,
 * so a skill edited for another tool is already current here — an import would
 * have frozen it on the day it ran.
 *
 * A malformed file is skipped rather than fatal: one bad skill in a shared
 * directory should not stop a session from starting.
 */
/**
 * Filenames that mean project instructions wherever they are found.
 *
 * One of these sitting in an agents directory is somebody's instructions in
 * the wrong place, and loading it as an agent would put a whole CLAUDE.md into
 * a system prompt as though it described a person.
 *
 * The trap runs the other way too, and is worse: on a case-insensitive
 * filesystem — the default on macOS — an agent named `claude` is written to
 * `claude.md`, which *is* `CLAUDE.md`, and every coding agent opened in that
 * repository then reads that agent's prompt as the project's instructions.
 * Compared case-insensitively for exactly that reason.
 */
const INSTRUCTIONS = new Set(['CLAUDE.MD', 'AGENTS.MD', 'README.MD'])

export const claudeLoader: Required<Loader> = defineLoader({
  name: 'claude',

  async loadInstructions(path: string): Promise<Instruction[]> {
    const text = (await readText(path))?.trim()
    return text ? [{ source: path, text }] : []
  },

  async loadSkills(directory: string): Promise<Skill[]> {
    const names = await subdirectories(directory)
    const skills: Skill[] = []

    for (const name of names) {
      const path = join(directory, name, 'SKILL.md')
      const source = await readText(path)
      if (source === undefined) continue

      const { data } = splitFrontmatter(source)
      const description = stringField(data, 'description')
      // Without a description the model has no basis for choosing the skill,
      // so an unlabelled one is worse than absent: it would be picked at random.
      if (!description) continue

      skills.push({ name: stringField(data, 'name') ?? name, description, path })
    }

    return skills
  },

  async loadAgents(directory: string): Promise<AgentDef[]> {
    const files = (await entries(directory))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
      .map((entry) => entry.name)
      .filter((name) => !INSTRUCTIONS.has(name.toUpperCase()))
      .sort()

    const agents: AgentDef[] = []

    for (const file of files) {
      const path = join(directory, file)
      const source = await readText(path)
      if (source === undefined) continue

      const { data, body } = splitFrontmatter(source)
      const description = stringField(data, 'description')
      if (!description) continue

      const provider = stringField(data, 'provider')
      const model = stringField(data, 'model')
      const tools = listField(data, 'tools')
      // What the agent is for, when it is not the only one doing it: two files
      // both declaring `role: coder` are two hands on the same work.
      const role = stringField(data, 'role')

      agents.push({
        id: stringField(data, 'name') ?? basename(file, '.md'),
        description,
        systemPrompt: body,
        ...(provider ? { provider } : {}),
        ...(model ? { model } : {}),
        ...(tools ? { tools } : {}),
        ...(role ? { role } : {}),
      })
    }

    return agents
  },
})

async function readText(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, 'utf8')
  } catch {
    // A configured path that is not there is simply nothing to load.
    return undefined
  }
}

async function entries(directory: string) {
  try {
    return await readdir(directory, { withFileTypes: true })
  } catch {
    return []
  }
}

/** Sorted, so what the model sees does not depend on filesystem order. */
async function subdirectories(directory: string): Promise<string[]> {
  return (await entries(directory))
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort()
}
