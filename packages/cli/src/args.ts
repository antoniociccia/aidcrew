import { resolve } from 'node:path'
import { parseArgs } from 'node:util'

export type CliArgs = {
  /** `run` is one agent; `team` is everyone the project declares. */
  command:
    | 'run'
    | 'team'
    | 'config'
    | 'ui'
    | 'models'
    | 'undo'
    | 'mcp'
    | 'plugin'
    | 'project'
    | 'forget'
    | 'demo'
    | 'keys'
  /** config only: the action and its arguments. */
  rest: string[]
  prompt: string
  cwd: string
  maxTurns: number
  help: boolean
  /** Print the version and stop. Asked for first in every bug report. */
  version: boolean
  /** team only: which agent receives the instruction. */
  to?: string
}

export class UsageError extends Error {
  override readonly name = 'UsageError'
}

export const USAGE = `aidcrew — a plugin-first multi-agent coding harness

Usage:
  aidcrew -p "<task>"              one agent
  aidcrew                          the interface: everything from one screen
  aidcrew ui                       the same, for a script that would rather say so
  aidcrew team -p "<task>"         the whole team declared by the project
  aidcrew demo                     sixty seconds to a working agent, with no key
  aidcrew models                   list what the provider offers
  aidcrew models use <id>          set the default model
  aidcrew models use <id> --all    set it for every configured agent too
  aidcrew models check             find out which ones actually answer
  aidcrew config                   show what is configured
  aidcrew config set-key <scope>   save a key, read from stdin
  aidcrew undo                     take back the last change an agent made
  aidcrew undo --list              show what could be taken back
  aidcrew plugin                   list the plugins that are loaded, and where from
  aidcrew plugin check <dir>       what the host will say about one, before you ship it
  aidcrew plugin trust <name>      let one that arrived with a clone run here
  aidcrew plugin revoke <name>     take that back
  aidcrew project                  what this project's config asks for that a clone does not get
  aidcrew project trust <claim>    allow one of them, here
  aidcrew project revoke <claim>   take that back
  aidcrew forget                   drop what deleted projects left behind
  aidcrew mcp                      list the MCP servers this project declares
  aidcrew mcp trust <server>       let one start here — it is a program, read it first
  aidcrew mcp check                connect to the trusted ones and list their tools
  aidcrew keys                     show what your terminal sends for a key

Options:
  -p, --prompt <text>   The task to work on. Required.
  -C, --cwd <dir>       Workspace directory. Defaults to the current directory.
      --to <agent>      team only: which agent gets the instruction.
      --max-turns <n>   Stop after this many model turns. Defaults to 50.
  -h, --help            Show this message.
  -v, --version         Show the version and stop.

Keys are saved once and remembered:

  aidcrew config set-key provider:zen        a whole service
  aidcrew config set-key agent:architect     one agent, on its own plan

Environment variables override what is saved, for CI and one-off runs:
  AIDCREW_PROVIDER            Default provider id. Defaults to "zen".
  AIDCREW_MODEL               Default model id.
  AIDCREW_API_KEY             Key for any provider without its own.
  AIDCREW_API_KEY_<PROVIDER>  Key for one provider, e.g. AIDCREW_API_KEY_ANTHROPIC.
  AIDCREW_BASE_URL            Endpoint override. Required for unknown providers.

Agents come from the files the project already has (.claude/agents by
default); .aidcrew/config.toml gives each one its provider and model.`

/**
 * Parses the command line, rejecting anything unexpected rather than ignoring
 * it: a silently dropped flag looks like the harness disobeyed an instruction.
 */
export function parseCliArgs(argv: string[]): CliArgs {
  let parsed: ReturnType<typeof parseArgs>
  try {
    parsed = parseArgs({
      args: argv,
      options: {
        prompt: { type: 'string', short: 'p' },
        cwd: { type: 'string', short: 'C' },
        'max-turns': { type: 'string' },
        to: { type: 'string' },
        all: { type: 'boolean', default: false },
        list: { type: 'boolean', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
      allowPositionals: true,
      strict: true,
    })
  } catch (cause) {
    throw new UsageError(cause instanceof Error ? cause.message : String(cause))
  }

  const values = parsed.values as {
    prompt?: string
    cwd?: string
    'max-turns'?: string
    to?: string
    help?: boolean
    version?: boolean
  }

  if (values.help || values.version) {
    return {
      command: 'run',
      rest: [],
      prompt: '',
      cwd: process.cwd(),
      maxTurns: 50,
      help: values.help === true,
      version: values.version === true,
    }
  }

  const positionals = parsed.positionals as string[]
  const command = readCommand(positionals)
  const rest = positionals.slice(1)

  if (
    command === 'config' ||
    command === 'ui' ||
    command === 'models' ||
    command === 'undo' ||
    command === 'mcp' ||
    command === 'plugin' ||
    command === 'project' ||
    command === 'forget' ||
    command === 'demo' ||
    command === 'keys'
  ) {
    // Settings take no task, and demanding one would be baffling. Flags meant
    // for these commands travel in `rest`, where the command itself reads them.
    // Flags for these commands travel in `rest`, where the command itself
    // reads them. Declared above as well, or strict parsing rejects them
    // before they get here — which reads as the harness disobeying an
    // instruction rather than as a flag it does not know.
    const named = values as { all?: boolean; list?: boolean }
    const flags = [...(named.all ? ['--all'] : []), ...(named.list ? ['--list'] : [])]
    return {
      command,
      rest: [...rest, ...flags],
      prompt: '',
      cwd: workspaceOf(values.cwd),
      maxTurns: 50,
      help: false,
      version: false,
    }
  }

  if (command === 'run' && values.to !== undefined) {
    throw new UsageError('--to only applies to "aidcrew team"')
  }

  // Nothing at all means the interface: someone who typed `aidcrew` wants to
  // start working, not to read a usage message. An explicitly empty -p is a
  // different thing — a mistake — and still gets an error.
  if (!values.prompt || values.prompt.trim() === '') {
    if (command === 'run' && positionals.length === 0 && values.prompt === undefined) {
      return {
        command: 'ui',
        rest: [],
        prompt: '',
        cwd: workspaceOf(values.cwd),
        maxTurns: 50,
        help: false,
        version: false,
      }
    }
    throw new UsageError('a task is required: pass it with -p "..."')
  }

  const maxTurns = readMaxTurns(values['max-turns'])

  return {
    command,
    rest,
    prompt: values.prompt,
    cwd: workspaceOf(values.cwd),
    maxTurns,
    help: false,
    version: false,
    ...(values.to === undefined ? {} : { to: values.to }),
  }
}

/**
 * The workspace as a directory, rather than as it was typed.
 *
 * Everything keyed by the workspace — trust, the transcript, the "outside this
 * project" test on a cloned config — compares this string, and `-C proj/` is
 * what shell completion types: with the slash kept, every one of the project's
 * own files was "outside this project". Resolved once, here, so nothing
 * downstream has to remember to.
 */
function workspaceOf(cwd: string | undefined): string {
  return resolve(cwd ?? process.cwd())
}

function readCommand(positionals: string[]): CliArgs['command'] {
  const [verb, ...extra] = positionals
  if (verb === undefined) return 'run'

  if (
    verb === 'config' ||
    verb === 'ui' ||
    verb === 'models' ||
    verb === 'undo' ||
    verb === 'mcp' ||
    verb === 'plugin' ||
    verb === 'project' ||
    verb === 'forget' ||
    verb === 'demo' ||
    verb === 'keys'
  ) {
    return verb
  }
  if (verb !== 'run' && verb !== 'team') {
    throw new UsageError(
      `unknown command "${verb}". Use "run", "team", "ui", "models", "plugin", ` +
        '"project", "forget", "demo", "mcp", "undo", "keys" or "config".',
    )
  }
  if (extra.length > 0) {
    throw new UsageError(`unexpected argument: ${extra[0]}`)
  }
  return verb
}

function readMaxTurns(raw: string | undefined): number {
  const value = raw === undefined ? 50 : Number(raw)
  if (!Number.isInteger(value) || value < 1) {
    throw new UsageError('--max-turns must be a positive whole number')
  }
  return value
}
