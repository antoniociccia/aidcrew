/**
 * What you can type instead of talking to a model.
 *
 * Everything here is something the interface could already do through a
 * keyboard shortcut or a config file, and neither is any use in the middle of
 * a thought: adding an agent because this task turned out bigger than expected
 * should not mean leaving the session to edit a file.
 *
 * Parsing lives apart from the interface so what a line means can be settled
 * without a terminal, and so the same line means the same thing wherever it is
 * typed.
 */

export type Command =
  | { at: 'help' }
  | { at: 'spawn'; role: string; model?: string; provider?: string }
  | { at: 'kill'; agent: string }
  | { at: 'tell'; agent: string; text: string }
  | { at: 'diff'; agent?: string }
  | { at: 'stop'; agent?: string }
  | { at: 'clear'; agent?: string }
  | { at: 'drop'; agent?: string }
  | { at: 'model'; model: string; provider?: string }
  | { at: 'yolo'; agent?: string; on: boolean }
  | { at: 'copy'; agent?: string }
  | { at: 'task'; name: string; roles: string[] }
  | { at: 'split' }
  | { at: 'mcp' }
  | { at: 'tour' }
  /** Typed with a slash, but nothing we know. Carries the nearest match. */
  | { at: 'unknown'; typed: string; nearest?: string }

export type CommandSpec = {
  name: string
  args: string
  what: string
}

/**
 * The list, which is also the help.
 *
 * One source rather than two: help that is written separately is help that
 * describes the version before last.
 */
export const COMMANDS: CommandSpec[] = [
  { name: 'spawn', args: '<role> [provider] [model]', what: 'Start another agent on this job.' },
  {
    name: 'task',
    args: '<name> [roles...]',
    what: 'Start a job in a checkout of its own, with its own agents.',
  },
  {
    name: 'kill',
    args: '<agent>',
    what: 'Stop an agent. Its worktree goes too, unless there is work in it.',
  },
  { name: 'tell', args: '<agent> <message>', what: 'Send a message to an agent by name.' },
  { name: 'diff', args: '[agent]', what: 'Show what an agent has changed in its worktree.' },
  { name: 'stop', args: '[agent]', what: 'Stop the turn in flight, leaving the agent standing.' },
  {
    name: 'clear',
    args: '[agent]',
    what: 'Forget this conversation and begin again. What it has spent stays.',
  },
  { name: 'drop', args: '[agent]', what: 'Drop what an agent has queued, leaving the turn alone.' },
  {
    name: 'model',
    args: '[provider] <model>',
    what: 'Change the model this agent runs on, and the service if you name one.',
  },
  {
    name: 'yolo',
    args: '[agent] [off]',
    what: 'Let an agent act without asking, for this session only.',
  },
  {
    name: 'copy',
    args: '[agent]',
    what: 'Put what an agent has said on the clipboard. Hold option and drag to select by hand.',
  },
  { name: 'split', args: '', what: 'Choose which agents are shown side by side.' },
  { name: 'mcp', args: '', what: 'List the MCP servers this project declares.' },
  { name: 'tour', args: '', what: 'What this program is, in eight pages.' },
  { name: 'help', args: '', what: 'This list.' },
]

/** Whether a line is a command at all. A lone slash is not. */
export function isCommand(text: string): boolean {
  const trimmed = text.trimStart()
  return trimmed.startsWith('/') && trimmed.length > 1 && !trimmed.startsWith('//')
}

/**
 * Reads a typed line into a command.
 *
 * Returns undefined for anything that is not one, so a message that happens to
 * begin with a slash — a path, a regular expression — still reaches the model.
 */
export function parseCommand(text: string): Command | undefined {
  if (!isCommand(text)) return undefined

  const trimmed = text.trim().slice(1)
  const [verb = '', ...rest] = trimmed.split(/\s+/)
  const tail = trimmed.slice(verb.length).trim()

  switch (verb) {
    case 'help':
    case '?':
      return { at: 'help' }

    case 'split':
      return { at: 'split' }

    case 'mcp':
      return { at: 'mcp' }

    case 'tour':
      return { at: 'tour' }

    case 'spawn': {
      const [role, second, third] = rest
      if (!role) return { at: 'unknown', typed: '/spawn', nearest: 'spawn' }
      // A second word is the model, and a third is read as provider/model
      // written apart — the two spellings people actually use.
      const model = second === undefined ? undefined : third === undefined ? second : third
      const provider = third === undefined ? undefined : second
      return {
        at: 'spawn',
        role,
        ...(model ? { model } : {}),
        ...(provider ? { provider } : {}),
      }
    }

    case 'kill': {
      const [agent] = rest
      return agent ? { at: 'kill', agent } : { at: 'unknown', typed: '/kill', nearest: 'kill' }
    }

    case 'tell': {
      const [agent] = rest
      const message = tail.slice(agent?.length ?? 0).trim()
      if (!agent || message === '') {
        return { at: 'unknown', typed: '/tell', nearest: 'tell' }
      }
      return { at: 'tell', agent, text: message }
    }

    case 'task': {
      const [name, ...roles] = rest.filter((word) => word !== '')
      if (!name) return { at: 'unknown', typed: '/task', nearest: 'task' }
      return { at: 'task', name, roles }
    }

    case 'copy':
      return { at: 'copy', ...(rest[0] ? { agent: rest[0] } : {}) }

    case 'diff':
      return { at: 'diff', ...(rest[0] ? { agent: rest[0] } : {}) }

    case 'stop':
      return { at: 'stop', ...(rest[0] ? { agent: rest[0] } : {}) }

    case 'clear':
      return { at: 'clear', ...(rest[0] ? { agent: rest[0] } : {}) }

    case 'drop':
      return { at: 'drop', ...(rest[0] ? { agent: rest[0] } : {}) }

    case 'yolo': {
      // `off` can be given either way round, because both readings are
      // natural and refusing one of them is pedantry.
      const words = rest.filter((word) => word !== '')
      const on = !words.includes('off')
      const agent = words.find((word) => word !== 'off' && word !== 'on')
      return { at: 'yolo', on, ...(agent ? { agent } : {}) }
    }

    case 'model': {
      // Two words are provider and model written apart, as `/spawn` reads
      // them. One reading for both, or `/model openai gpt-5` moves the agent
      // to a model called "openai".
      const [first, second] = rest.filter((word) => word !== '')
      if (!first) return { at: 'unknown', typed: '/model', nearest: 'model' }
      return second === undefined
        ? { at: 'model', model: first }
        : { at: 'model', provider: first, model: second }
    }

    default: {
      const suggestion = nearest(verb)
      return {
        at: 'unknown',
        typed: `/${verb}`,
        ...(suggestion === undefined ? {} : { nearest: suggestion }),
      }
    }
  }
}

/**
 * The command a typo was probably meant to be.
 *
 * A mistyped command that answers "unknown" and stops is a command you retype
 * from memory; one that names the nearest match is a command you fix.
 */
export function nearest(typed: string): string | undefined {
  let best: { name: string; distance: number } | undefined

  for (const command of COMMANDS) {
    const distance = editDistance(typed.toLowerCase(), command.name)
    if (!best || distance < best.distance) best = { name: command.name, distance }
  }

  // Beyond a third of the word wrong it is a guess, not a correction.
  return best && best.distance <= Math.max(1, Math.floor(typed.length / 3)) ? best.name : undefined
}

/**
 * The half-typed `@` at the end of a line, if there is one.
 *
 * Only at the end: completing something in the middle of a sentence would
 * replace text the person has already moved past, and `@` earlier in the line
 * is a mention they have finished writing.
 */
export function partialMention(text: string): string | undefined {
  const match = /(?:^|\s)@([^\s@]*)$/.exec(text)
  return match ? (match[1] ?? '') : undefined
}

/**
 * Files that could finish what is being typed, nearest match first.
 *
 * Matched on the whole path rather than only its start, because the part of a
 * path anybody remembers is the filename: `@auth` should find
 * `src/auth/guard.ts` without making somebody type the directories first.
 */
export function fileCompletions(typed: string, files: string[], limit = 6): string[] {
  if (typed === '') return files.slice(0, limit)

  const needle = typed.toLowerCase()
  const starts: string[] = []
  const named: string[] = []
  const contains: string[] = []

  for (const file of files) {
    const path = file.toLowerCase()
    const base = path.slice(path.lastIndexOf('/') + 1)

    if (path.startsWith(needle)) starts.push(file)
    // The filename ahead of a directory that merely shares the letters:
    // somebody typing `auth` means auth.ts far more often than they mean
    // everything under auth/.
    else if (base.startsWith(needle)) named.push(file)
    else if (path.includes(needle)) contains.push(file)
    if (starts.length >= limit) break
  }

  return [...starts, ...named, ...contains].slice(0, limit)
}

/** The commands that could complete what has been typed so far. */
export function completions(text: string): CommandSpec[] {
  if (!text.startsWith('/')) return []
  const typed = text.slice(1).split(/\s/)[0] ?? ''
  return COMMANDS.filter((command) => command.name.startsWith(typed.toLowerCase()))
}

/**
 * Edit distance, counting a swapped pair of letters as one mistake.
 *
 * Plain Levenshtein charges two for a transposition, which puts `spwan` two
 * away from `spawn` — far enough to refuse to suggest it, and transposing two
 * letters is the single most common way of mistyping a word.
 */
function editDistance(a: string, b: string): number {
  if (a === b) return 0

  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, at) => at)]

  for (let i = 0; i < a.length; i += 1) {
    const row = [i + 1]
    for (let j = 0; j < b.length; j += 1) {
      const substitution = (rows[i]?.[j] ?? 0) + (a[i] === b[j] ? 0 : 1)
      let best = Math.min((rows[i]?.[j + 1] ?? 0) + 1, (row[j] ?? 0) + 1, substitution)

      if (i > 0 && j > 0 && a[i] === b[j - 1] && a[i - 1] === b[j]) {
        best = Math.min(best, (rows[i - 1]?.[j - 1] ?? 0) + 1)
      }

      row.push(best)
    }
    rows.push(row)
  }

  return rows[a.length]?.[b.length] ?? 0
}
