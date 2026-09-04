import { readFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { ORCHESTRATION_FILE } from '@aidcrew/core'

export class WorkspaceConfigError extends Error {
  override readonly name = 'WorkspaceConfigError'
}

export type SourcePaths = {
  instructions: string[]
  skills: string[]
  agents: string[]
  /**
   * Where this project says how its team works.
   *
   * A list like the others, and read in order with the first that exists
   * winning, so somebody who would rather call the file something else — or
   * keep one in their home directory for every project — says so here instead
   * of being told what to name it.
   */
  orchestration: string[]
}

export type AgentOverride = {
  provider?: string
  model?: string
  tools?: string[]
  /**
   * Name of the environment variable holding this agent's key — never the key
   * itself. Two agents on the same provider can then run on different plans,
   * different accounts or different quotas.
   */
  apiKeyEnv?: string
  /**
   * Let this agent act without being asked first.
   *
   * Per agent, because trust is a property of the agent the way its model is:
   * a reviewer that only reads can be left alone, while the one rewriting your
   * auth code probably should not be. It never covers the handful of commands
   * that cannot be taken back — those are asked about however trusting the
   * setting, since "stop asking me" is a statement about routine work.
   */
  yolo?: boolean
  /**
   * Input tokens past which this agent's conversation is shortened.
   *
   * Per agent because it is a property of the model it runs on, and set below
   * what that model can take so there is room for the turn that discovers the
   * conversation has grown too long.
   */
  compactAt?: number
  /**
   * How long one of this agent's answers may be, when the default is wrong.
   *
   * Per agent for the reason `compactAt` is: it is a property of the model it
   * runs on. Needed only by a service that refuses the default.
   */
  maxTokens?: number
  /**
   * The provider that writes this agent's summaries, if not the agent itself.
   *
   * Summarising is small and mechanical work, and letting an expensive model
   * spend its budget on it is how a bill becomes hard to explain.
   */
  compactWith?: string
  /**
   * What this agent is for, when several agents share one job.
   *
   * Two entries named `coder` and `coder-night` with `role = "coder"` are two
   * hands on the same work: a message addressed to `coder` goes to whichever
   * is free. Absent, an agent's name is its own role and nothing changes.
   */
  role?: string
}

export type WorkspaceConfig = {
  sources: SourcePaths
  /**
   * Whether agents on a task keep a note the others can read.
   *
   * Off unless asked for, because it puts a paragraph in front of every agent
   * on the task on every request: worth it when a team is working something
   * out together, pure cost when one agent is doing a small job alone.
   */
  sharedMemory: boolean
  /**
   * Which agent leads this team, and therefore cannot be taken off it.
   *
   * A position rather than a kind: name any agent the project has. Everything
   * handed around comes back to it, so a job has somebody holding its end
   * rather than that being whoever was last typed at. Absent means the first
   * agent the project declares — a team always has a leader, and making you
   * name one before anything works would be a setting standing in the way.
   */
  leader?: string
  /**
   * How many tool calls one turn may make before it is stopped, when the
   * project's jobs are bigger than the built-in bound allows for. Absent means
   * the default.
   */
  toolCallsPerTurn?: number
  agents: Record<string, AgentOverride>
  /**
   * What a model costs, when the service will not say.
   *
   * Dollars per token. This is how a model on a service billed by
   * subscription gets a number — zero — and how anything a provider does not
   * publish gets one at all.
   */
  prices: Record<string, { input: number; output: number }>
  /**
   * Each plugin's own settings, from `[plugins.<name>]`.
   *
   * A plugin gets its own table and nobody else's: one reading another's
   * settings would be one reading another's tokens.
   */
  plugins: Record<string, Record<string, unknown>>
  defaults: { provider?: string; model?: string }
  /** Which config files were actually read, in the order they were applied. */
  files: string[]
  /**
   * What the project's config asked for and did not get.
   *
   * Empty for almost every project, and the whole reason this type has the
   * field: a thing quietly not done is a thing somebody spends an afternoon
   * on. Whoever reads the config says these out loud.
   */
  refused: Refusal[]
}

/**
 * One thing a project asked for that a clone does not get.
 *
 * The claim is what `aidcrew project trust` takes, so it is one argv token,
 * and for a path it carries the path rather than the field it was listed
 * under: allowing `./docs/RULES.md` must grant nothing to the `~/.ssh/id_rsa`
 * a later commit appends to the same list.
 */
export type Refusal = { claim: string; because: string }

export type WorkspaceOptions = {
  cwd: string
  home: string
  /**
   * Whether this project may have one of the things a clone does not get.
   *
   * Absent means no, the answer `allowPlugin` and `allowServer` give for the
   * same reason: a caller that forgets is a caller that reads a stranger's
   * config as if the user had written it. Said yes to by typing
   * `aidcrew project trust <claim>`, never by a prompt in the middle of
   * something else.
   */
  trusted?(claim: string): boolean
}

const CONFIG_PATH = join('.aidcrew', 'config.toml')

/**
 * Where the usual layout puts things, if nobody says otherwise.
 *
 * These are read in place, never copied: a skill edited for another tool is
 * already current here, whereas an import would have frozen it on the day it
 * ran. Paths that do not exist cost nothing — loaders treat them as empty.
 */
function defaultSources({ cwd, home }: WorkspaceOptions): SourcePaths {
  return {
    instructions: [
      join(home, '.claude', 'CLAUDE.md'),
      join(cwd, 'CLAUDE.md'),
      join(cwd, 'AGENTS.md'),
    ],
    skills: [join(home, '.claude', 'skills'), join(cwd, '.claude', 'skills')],
    // `.aidcrew/agents` last, so an agent the interface wrote wins over one
    // of the same name found elsewhere.
    // A team of your own, then the project's. Everything else of yours in
    // ~/.aidcrew is read — plugins, themes, MCP servers, settings — and agents
    // were the exception, so a team written once could not be used again and
    // every new project began by asking you to invent one, with the files you
    // meant sitting unread in your home directory.
    agents: [
      join(home, '.claude', 'agents'),
      join(home, '.aidcrew', 'agents'),
      join(cwd, '.claude', 'agents'),
      join(cwd, '.aidcrew', 'agents'),
    ],
    // The project's own first: a file in a home directory is a preference
    // about how you like teams to work, and the one in the repository is how
    // this team works. The nearer answer wins.
    orchestration: [join(cwd, ORCHESTRATION_FILE), join(home, '.aidcrew', ORCHESTRATION_FILE)],
  }
}

/**
 * A record of things the config names, inheriting nothing.
 *
 * Every one of these is looked up by a name the config file chose, and the
 * config file arrives with a clone. Without this, `plugins["toString"]` answers
 * with a function and `agents["constructor"]` with the Object constructor: a
 * plugin that declared no settings is handed some, and no amount of care at the
 * read sites would show it, since the value is not a key of the record.
 */
function byName<T>(): Record<string, T> {
  return Object.create(null) as Record<string, T>
}

/**
 * Reads the user config and then the project config, the second overriding the
 * first — except for agents, which merge, so a project can add to a shared team
 * without redeclaring it.
 */
export async function loadWorkspaceConfig(options: WorkspaceOptions): Promise<WorkspaceConfig> {
  const config: WorkspaceConfig = {
    sources: defaultSources(options),
    sharedMemory: false,
    agents: byName(),
    prices: byName(),
    plugins: byName(),
    defaults: {},
    files: [],
    refused: [],
  }

  for (const base of [options.home, options.cwd]) {
    const path = join(base, CONFIG_PATH)
    const parsed = await readConfig(path)
    if (!parsed) continue

    config.files.push(path)
    // The user's own file needs no permission — they decided when they wrote
    // it — and the project's does, because it arrived with a clone. That is
    // the same sentence `pluginDirectoriesFor` says about directories, and
    // the config file is the door the plugin gate does not cover. Somebody
    // opening their home directory as a project owns both, so it is the file
    // that decides, not the position in this loop.
    apply(config, parsed, path, options, base === options.home ? 'user' : 'project')
  }

  // Wherever the interface writes an agent is read, whatever the config says.
  // A project declaring its own agent paths used to replace this one too, so
  // "add an agent" wrote a file nothing read again: the new agent appeared to
  // vanish, and removing one appeared to do nothing at all. Last in the list,
  // so an agent written here still wins over one of the same name elsewhere.
  const own = join(options.cwd, '.aidcrew', 'agents')
  if (!config.sources.agents.includes(own)) config.sources.agents.push(own)

  return config
}

type RawConfig = {
  sources?: Record<string, unknown>
  agents?: Record<string, unknown>
  prices?: Record<string, unknown>
  defaults?: Record<string, unknown>
  plugins?: Record<string, unknown>
}

async function readConfig(path: string): Promise<RawConfig | undefined> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch {
    return undefined
  }

  try {
    return Bun.TOML.parse(text) as RawConfig
  } catch (cause) {
    throw new WorkspaceConfigError(
      `${path} is not valid TOML: ${cause instanceof Error ? cause.message : String(cause)}`,
    )
  }
}

function apply(
  config: WorkspaceConfig,
  raw: RawConfig,
  path: string,
  options: WorkspaceOptions,
  scope: 'user' | 'project',
): void {
  const trusted = options.trusted ?? (() => false)

  for (const key of ['instructions', 'skills', 'agents', 'orchestration'] as const) {
    const declared = raw.sources?.[key]
    if (declared === undefined) continue
    // Read before the list is replaced, because the question is what this
    // file ADDS: a path already on the list is one that would be read whether
    // this file existed or not, so allowing it discloses nothing. That is
    // also what makes the built-in defaults and the user's own config exempt
    // without a case of their own — they are already there.
    const already = new Set(config.sources[key])
    const wanted = readPathList(declared, `sources.${key}`, path, options)
    config.sources[key] =
      scope === 'user'
        ? wanted
        : wanted.filter((entry) => {
            if (already.has(entry) || !escapes(entry, options.cwd)) return true
            const claim = `sources.${key}=${entry}`
            if (trusted(claim)) return true
            config.refused.push({ claim, because: whyPath(key, entry) })
            return false
          })
  }

  // Agents merge rather than replace, so a project can add one member to a
  // team declared once in the user config.
  for (const [id, value] of Object.entries(raw.agents ?? {})) {
    const read = readAgent(value, id, path)
    // Taken off what this file says rather than off the merged result: strip
    // it afterwards and a project restating what the user already allows
    // silently revokes the user's own decision, and says so on screen.
    if (scope === 'project' && read.yolo === true && config.agents[id]?.yolo !== true) {
      const claim = `agents.${id}.yolo`
      if (!trusted(claim)) {
        delete read.yolo
        config.refused.push({ claim, because: `lets "${id}" act without ever being asked` })
      }
    }
    config.agents[id] = { ...config.agents[id], ...read }
  }

  // Plugin settings merge the same way, so a machine-wide default can be
  // adjusted by the project that knows better.
  for (const [name, value] of Object.entries(raw.plugins ?? {})) {
    config.plugins[name] = { ...config.plugins[name], ...readPluginConfig(value, name, path) }
  }

  // Prices merge the same way agents do: one stated for the whole machine can
  // be corrected by the project that knows better.
  for (const [model, value] of Object.entries(raw.prices ?? {})) {
    const price = readPrice(value, model, path)
    if (price) config.prices[model] = price
  }

  // A team note is a way of working, so it is declared per project rather
  // than per machine — and it is off until somebody says otherwise.
  if (raw.defaults?.sharedMemory !== undefined) {
    if (typeof raw.defaults.sharedMemory !== 'boolean') {
      throw new WorkspaceConfigError(`${path}: defaults.sharedMemory must be true or false`)
    }
    config.sharedMemory = raw.defaults.sharedMemory
  }

  const leader = readString(raw.defaults?.leader, 'defaults.leader', path)
  if (leader !== undefined) config.leader = leader

  const calls = raw.defaults?.toolCallsPerTurn
  if (calls !== undefined) {
    if (typeof calls !== 'number' || !Number.isInteger(calls) || calls <= 0) {
      throw new WorkspaceConfigError(
        `${path}: defaults.toolCallsPerTurn must be a positive whole number`,
      )
    }
    config.toolCallsPerTurn = calls
  }

  const provider = readString(raw.defaults?.provider, 'defaults.provider', path)
  const model = readString(raw.defaults?.model, 'defaults.model', path)
  if (provider !== undefined) config.defaults.provider = provider
  if (model !== undefined) config.defaults.model = model
}

/**
 * Whether a path leaves the project it was declared in.
 *
 * Decided with `relative()` and not a string prefix, for the two ways a prefix
 * lies. `<repo>/../home/.ssh/id_rsa` begins with the project directory and is
 * not in it, and a prefix test read that file into every request. The other
 * way round, `aidcrew -C proj/` — what shell completion types — made the
 * prefix `proj//`, which nothing begins with, so every path the project named
 * for itself was "outside this project" and silently dropped. Both spellings
 * resolve to one directory, and it is the directory that is compared.
 *
 * By path, which a symlink committed inside the repository defeats — but a
 * symlink is a file in the diff somebody reviews, and `~/.aws/credentials`
 * buried in a TOML table is not. This closes the one that hides.
 */
function escapes(path: string, cwd: string): boolean {
  const from = relative(cwd, path)
  return from === '..' || from.startsWith(`..${sep}`) || isAbsolute(from)
}

/** Why one refused path matters, in the words the person will read. */
function whyPath(key: keyof SourcePaths, path: string): string {
  if (key === 'instructions') {
    return `reads ${path}, which is outside this project, into every request`
  }
  if (key === 'orchestration') {
    return `takes how the team works from ${path}, which is outside this project — and that text reaches every agent on every request`
  }
  if (key === 'skills') return `offers the skills in ${path}, which is outside this project`
  return `takes agents from ${path}, which is outside this project — and an agent definition is a system prompt`
}

/** Paths are resolved against the project, never against the shell's cwd. */
function readPathList(
  value: unknown,
  field: string,
  path: string,
  options: WorkspaceOptions,
): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new WorkspaceConfigError(`${path}: ${field} must be a list of paths`)
  }
  return (value as string[]).map((entry) => expand(entry, options))
}

function expand(entry: string, { cwd, home }: WorkspaceOptions): string {
  if (entry === '~') return home
  if (entry.startsWith('~/')) return join(home, entry.slice(2))
  // Resolved even when absolute: a `..` inside an absolute path is how one
  // that begins with the project leaves it, and the claim has to name where
  // the path goes so that what gets trusted is the file and not a spelling.
  return resolve(cwd, entry)
}

function readAgent(value: unknown, id: string, path: string): AgentOverride {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceConfigError(`${path}: agents.${id} must be a table`)
  }

  const raw = value as Record<string, unknown>
  const provider = readString(raw.provider, `agents.${id}.provider`, path)
  const model = readString(raw.model, `agents.${id}.model`, path)
  const apiKeyEnv = readEnvName(raw.apiKeyEnv, `agents.${id}.apiKeyEnv`, path)
  const tools = raw.tools

  if (tools !== undefined && (!Array.isArray(tools) || tools.some((t) => typeof t !== 'string'))) {
    throw new WorkspaceConfigError(`${path}: agents.${id}.tools must be a list of tool names`)
  }

  // Said explicitly or not at all: a string like "no" reading as true is how a
  // setting meant to hold an agent back ends up letting it go.
  if (raw.yolo !== undefined && typeof raw.yolo !== 'boolean') {
    throw new WorkspaceConfigError(`${path}: agents.${id}.yolo must be true or false`)
  }

  // A budget that is not a positive number would compact on every turn or on
  // none, and neither failure announces itself.
  if (
    raw.compactAt !== undefined &&
    (typeof raw.compactAt !== 'number' || !Number.isFinite(raw.compactAt) || raw.compactAt <= 0)
  ) {
    throw new WorkspaceConfigError(`${path}: agents.${id}.compactAt must be a positive number`)
  }
  if (
    raw.maxTokens !== undefined &&
    (typeof raw.maxTokens !== 'number' || !Number.isFinite(raw.maxTokens) || raw.maxTokens <= 0)
  ) {
    throw new WorkspaceConfigError(`${path}: agents.${id}.maxTokens must be a positive number`)
  }
  const compactWith = readString(raw.compactWith, `agents.${id}.compactWith`, path)
  const role = readString(raw.role, `agents.${id}.role`, path)

  return {
    ...(provider ? { provider } : {}),
    ...(model ? { model } : {}),
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
    ...(tools ? { tools: tools as string[] } : {}),
    ...(raw.yolo === true ? { yolo: true } : {}),
    ...(typeof raw.compactAt === 'number' ? { compactAt: raw.compactAt } : {}),
    ...(typeof raw.maxTokens === 'number' ? { maxTokens: raw.maxTokens } : {}),
    ...(compactWith ? { compactWith } : {}),
    ...(role ? { role } : {}),
  }
}

/**
 * One plugin's settings, refusing anything that looks like a credential.
 *
 * This file is committed. The rule `apiKeyEnv` already enforces for agents
 * applies here for the same reason: a key pasted into a plugin's table is the
 * single most likely way to leak one, and a plugin that needs a secret should
 * name the variable holding it instead. It applies to the whole table and not
 * just its first level, since a nested one is committed exactly as hard.
 */
function readPluginConfig(value: unknown, name: string, path: string): Record<string, unknown> {
  if (NOT_A_PLUGIN_NAME.has(name)) {
    throw new WorkspaceConfigError(
      `${path}: plugins.${name} is not a plugin name. __proto__, constructor and prototype ` +
        'name JavaScript itself rather than anything installed, and a table under one of them ' +
        'is read as settings by plugins that declared none.',
    )
  }

  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new WorkspaceConfigError(`${path}: plugins.${name} must be a table`)
  }

  refuseCredentials(value as Record<string, unknown>, `plugins.${name}`, path)
  return value as Record<string, unknown>
}

/**
 * Names that mean JavaScript rather than a plugin.
 *
 * The record they land in inherits nothing, so a table under one of these is
 * already harmless; it is refused anyway because it is not a mistake anybody
 * makes by accident, and a repository that arrived with one was trying to
 * reach a plugin whose settings it does not get to write.
 */
const NOT_A_PLUGIN_NAME = new Set(['__proto__', 'constructor', 'prototype'])

/**
 * Walks a plugin's settings whole, refusing every field named like a secret.
 *
 * Whole, because a key is as committed in `[plugins.standup.auth]` as it is at
 * the top of the table, and as committed inside a list as beside one. The
 * message names the full path for the same reason it names the file: one that
 * says only `token` sends somebody reading every table in it.
 */
function refuseCredentials(table: Record<string, unknown>, at: string, path: string): void {
  for (const [key, held] of Object.entries(table)) {
    const where = `${at}.${key}`
    if (namesACredential(key)) {
      throw new WorkspaceConfigError(
        `${path}: ${where} looks like a credential, and this file is committed. ` +
          `Name the environment variable that holds it — ${namingAVariable(key)} = "SOME_VARIABLE" — instead.`,
      )
    }
    descend(held, where, path)
  }
}

function descend(held: unknown, where: string, path: string): void {
  if (Array.isArray(held)) {
    for (const [index, item] of held.entries()) descend(item, `${where}[${index}]`, path)
    return
  }
  if (typeof held === 'object' && held !== null) {
    refuseCredentials(held as Record<string, unknown>, where, path)
  }
}

/** The words a secret is kept under, singular and plural. */
const SECRET_WORDS = new Set([
  'key',
  'keys',
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwords',
  'credential',
  'credentials',
])

/**
 * Whether a field name's last word is one of those, rather than its last letters.
 *
 * The difference between the two is the whole rule. `monkey` and `keyboard` end
 * in the letters of one and are ordinary settings, while `authToken`, `api_key`
 * and `tokens` are keys and none of them ends in a bare word at all. So the name
 * is cut into words — at separators and at camelCase boundaries — and only the
 * last of them is read. The escape falls out of the same rule rather than being
 * a case beside it: `apiKeyEnv` and `api_key_env` end in `env`, and the name of
 * a variable is not what the variable holds.
 *
 * `api` is then taken off the front of that last word, because `apikey` is one
 * word to every splitter and a credential to every reader. Only that prefix,
 * and only there: it is the one word people run together with these, and
 * stripping anything more would take `monkey` with it.
 */
function namesACredential(key: string): boolean {
  const words = key.split(/[^A-Za-z0-9]+|(?<=[a-z0-9])(?=[A-Z])/).filter(Boolean)
  const last = words.at(-1)?.toLowerCase()
  if (last === undefined) return false
  return SECRET_WORDS.has(last) || SECRET_WORDS.has(last.replace(/^api/, ''))
}

/** The same field, spelled the way that names a variable, in the caller's own style. */
function namingAVariable(key: string): string {
  if (key.includes('_')) return `${key}_env`
  if (key.includes('-')) return `${key}-env`
  return `${key}Env`
}

/**
 * A price stated by hand, which is how a subscription-billed service gets a number.
 *
 * Both halves or neither: half a price would produce a total that looks
 * authoritative and is wrong, which is worse than a total that is missing.
 */
function readPrice(
  value: unknown,
  model: string,
  path: string,
): { input: number; output: number } | undefined {
  if (typeof value !== 'object' || value === null) {
    throw new WorkspaceConfigError(`${path}: prices."${model}" must be a table`)
  }

  const raw = value as Record<string, unknown>
  const input = raw.input
  const output = raw.output

  if (input === undefined && output === undefined) return undefined
  if (
    typeof input !== 'number' ||
    typeof output !== 'number' ||
    !Number.isFinite(input) ||
    !Number.isFinite(output) ||
    input < 0 ||
    output < 0
  ) {
    throw new WorkspaceConfigError(
      `${path}: prices."${model}" needs input and output, both dollars per token`,
    )
  }

  return { input, output }
}

/** Environment variable names, as the shell spells them. */
const ENV_NAME = /^[A-Z_][A-Z0-9_]*$/

/**
 * Reads a variable *name*, refusing anything that looks like a value.
 *
 * This file is committed. A key pasted here instead of the variable holding it
 * is the single most likely way to leak one, and the shape of a name is
 * distinctive enough to catch it.
 */
function readEnvName(value: unknown, field: string, path: string): string | undefined {
  const name = readString(value, field, path)
  if (name === undefined) return undefined

  if (!ENV_NAME.test(name)) {
    throw new WorkspaceConfigError(
      `${path}: ${field} must be an environment variable name such as ANTHROPIC_KEY_WORK, ` +
        'not a key. Put the key in that variable instead: this file is committed.',
    )
  }
  return name
}

function readString(value: unknown, field: string, path: string): string | undefined {
  if (value === undefined) return undefined
  if (typeof value !== 'string') {
    throw new WorkspaceConfigError(`${path}: ${field} must be a string`)
  }
  return value
}
