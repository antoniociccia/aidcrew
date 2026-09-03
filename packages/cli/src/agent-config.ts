import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { WorkspaceConfigError } from './workspace.ts'

/**
 * Editing `.aidcrew/config.toml` on the user's behalf.
 *
 * The file stays a file — committed, reviewable, readable without this tool —
 * but nobody has to write TOML by hand to give an agent a model. Existing
 * content is preserved: someone may have written things here that the
 * interface does not know about yet, and losing them would be unforgivable.
 */

const CONFIG_PATH = join('.aidcrew', 'config.toml')

export type AgentSettings = {
  provider?: string
  model?: string
  tools?: string[]
  /** Let this agent act without being asked first. See AgentOverride.yolo. */
  yolo?: boolean
}

/**
 * Sets one agent's provider and model, leaving the rest of the file alone.
 *
 * The whole file is parsed and rewritten rather than patched textually, so an
 * agent's settings end up in one place instead of being appended twice with
 * the second silently winning.
 */
export async function setAgentModel(
  cwd: string,
  agentId: string,
  settings: AgentSettings,
): Promise<void> {
  const path = join(cwd, CONFIG_PATH)
  const current = await readConfig(path)

  const agents = { ...(current.agents ?? {}) }
  agents[agentId] = { ...(agents[agentId] ?? {}), ...settings }

  await mkdir(join(cwd, '.aidcrew'), { recursive: true })
  await writeFile(path, render({ ...current, agents }), 'utf8')
}

/**
 * Adds or removes one of the places skills, agents and instructions are read
 * from, leaving the rest of the file alone.
 *
 * A path is a decision about the project — where this team's skills live —
 * which is why it belongs in the committed config and not in a database on one
 * person's machine.
 */
/**
 * Turns the team's shared note on or off, in the project.
 *
 * Written to the project rather than to this machine: whether a team keeps
 * notes is a property of how the work is done there, and the next person to
 * clone the repository should inherit the answer rather than discover it.
 */
export async function setSharedMemory(cwd: string, on: boolean): Promise<void> {
  const path = join(cwd, CONFIG_PATH)
  const current = await readConfig(path)

  await mkdir(join(cwd, '.aidcrew'), { recursive: true })
  await writeFile(
    path,
    render({ ...current, defaults: { ...current.defaults, sharedMemory: on } }),
    'utf8',
  )
}

export async function setSourcePaths(
  cwd: string,
  kind: 'instructions' | 'skills' | 'agents' | 'orchestration',
  paths: string[],
  home = homedir(),
): Promise<void> {
  const path = join(cwd, CONFIG_PATH)
  const current = await readConfig(path)

  // Duplicates would make a skill load twice under the same name, and the
  // second one wins by nothing more than the order the directories were read.
  const sources = {
    ...(current.sources ?? {}),
    [kind]: [...new Set(paths.map((entry) => portable(entry, cwd, home)))],
  }

  await mkdir(join(cwd, '.aidcrew'), { recursive: true })
  await writeFile(path, render({ ...current, sources }), 'utf8')
}

/**
 * A path as it should be written into a file other people will read.
 *
 * This config is committed, so an absolute path under one person's home is a
 * path that exists on exactly one machine — and it shows up in the diff of a
 * repository with their name in it. Inside the project it becomes relative;
 * inside the home directory it becomes `~`; anywhere else it stays as it is,
 * because `/opt/team/skills` means the same thing to everybody.
 */
function portable(entry: string, cwd: string, home: string): string {
  if (entry === cwd) return '.'
  if (entry.startsWith(`${cwd}/`)) return `./${entry.slice(cwd.length + 1)}`
  if (entry === home) return '~'
  if (entry.startsWith(`${home}/`)) return `~/${entry.slice(home.length + 1)}`
  return entry
}

export async function removeAgentSettings(cwd: string, agentId: string): Promise<void> {
  const path = join(cwd, CONFIG_PATH)
  const current = await readConfig(path)
  if (!current.agents?.[agentId]) return

  const agents = { ...current.agents }
  delete agents[agentId]

  await writeFile(path, render({ ...current, agents }), 'utf8')
}

type Config = {
  sources?: Record<string, string[]>
  defaults?: Record<string, string | boolean>
  agents?: Record<string, AgentSettings>
  /** Every other table in the file, kept as read so it can be written back. */
  [section: string]: unknown
}

/** The tables this file writes itself; everything else is passed through. */
const KNOWN = new Set(['sources', 'defaults', 'agents'])

/**
 * The file as it is, or nothing when there is no file — never something in
 * between.
 *
 * A file TOML could not parse used to read as empty, so the tool would "start
 * clean rather than refuse to work". What it started clean on was the write:
 * choosing a model while `broken = ` sat in [defaults] replaced every other
 * agent, every price and every default with the one table just written, and
 * said nothing. A writer must never write over a file it could not read; a
 * caller that only reads may catch this and report it.
 */
async function readConfig(path: string): Promise<Config> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (cause) {
    if (isMissing(cause)) return {}
    throw cause
  }

  try {
    return Bun.TOML.parse(text) as Config
  } catch (cause) {
    throw new WorkspaceConfigError(
      `${path} is not valid TOML: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

/** No file at all, which is where every project starts. */
function isMissing(cause: unknown): boolean {
  return cause instanceof Error && 'code' in cause && cause.code === 'ENOENT'
}

/**
 * Writes TOML by hand, because Bun parses it but does not serialise it.
 *
 * Everything the file held comes back out. The three tables this tool edits
 * are written in its own shape; the rest are written back as they parsed,
 * because a config writer that only knows its own settings quietly deletes
 * everyone else's — `[prices]` disappeared the first time somebody chose a
 * model, and nothing said so.
 */
function render(config: Config): string {
  const parts: string[] = [
    '# Written by aidcrew. Safe to edit and to commit — it holds no secrets.',
  ]

  if (config.sources && Object.keys(config.sources).length > 0) {
    parts.push('', '[sources]')
    for (const [key, value] of Object.entries(config.sources)) {
      parts.push(`${key} = ${JSON.stringify(value)}`)
    }
  }

  if (config.defaults && Object.keys(config.defaults).length > 0) {
    parts.push('', '[defaults]')
    for (const [key, value] of Object.entries(config.defaults)) {
      parts.push(`${key} = ${JSON.stringify(value)}`)
    }
  }

  for (const [id, settings] of Object.entries(config.agents ?? {})) {
    // Quoted when it is not a bare word. An agent file may say `name: Code
    // Reviewer`, and that is its id: written bare, the file stopped being
    // TOML and the next start failed on a line the person never typed.
    parts.push('', `[agents.${quoted(id)}]`)
    for (const [key, value] of Object.entries(settings)) {
      if (value !== undefined) parts.push(`${key} = ${JSON.stringify(value)}`)
    }
  }

  for (const [name, value] of Object.entries(config)) {
    if (KNOWN.has(name) || value === undefined) continue
    parts.push(...table(name, value))
  }

  return `${parts.join('\n')}\n`
}

/**
 * One table as it parsed, including the sub-tables under it.
 *
 * A key needs quoting when it is not a bare word — `prices."gpt-4.1"` is a
 * table name with dots in it, and writing it unquoted produces a file that
 * parses as something else entirely.
 */
function table(name: string, value: unknown): string[] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return ['', `${name} = ${JSON.stringify(value)}`]
  }

  const entries = Object.entries(value as Record<string, unknown>)
  const nested = entries.filter(([, item]) => isTable(item))
  const plain = entries.filter(([, item]) => !isTable(item))

  const out: string[] = []
  if (plain.length > 0 || nested.length === 0) {
    out.push('', `[${name}]`)
    for (const [key, item] of plain) out.push(`${quoted(key)} = ${JSON.stringify(item)}`)
  }
  for (const [key, item] of nested) out.push(...table(`${name}.${quoted(key)}`, item))
  return out
}

const isTable = (value: unknown): boolean =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const BARE = /^[A-Za-z0-9_-]+$/
const quoted = (key: string): string => (BARE.test(key) ? key : JSON.stringify(key))
