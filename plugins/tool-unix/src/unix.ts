import { relative } from 'node:path'
import { defineTool } from '@aidcrew/plugin-sdk'
import { resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'

/**
 * Three familiar programs, given to an agent directly.
 *
 * All three only read. That is what makes them worth having as tools rather
 * than as shell commands: the guards have to treat `bash` as something that
 * might change the machine, so counting the lines in a file gets the same
 * approval prompt as deleting it, and the prompt that appears for everything
 * is the prompt people stop reading.
 *
 * `awk` is the one that needs care, and it gets it below: it is a language,
 * and its language can write files and start processes. Those programs are
 * refused here rather than approved, because an agent that wants to change the
 * machine should say so through `bash`, where what it is about to do is
 * visible as a command instead of hidden inside an expression.
 */

/** Enough output to answer a question, not enough to fill a context window. */
const MAX_OUTPUT = 60_000
const TIMEOUT_MS = 10_000

export const wcTool = defineTool({
  name: 'wc',
  reads: true,
  description:
    'Count the lines, words and characters in a file, or in every file matching a glob. ' +
    'Use it to size a file before reading it.',
  schema: z.object({
    path: z.string().describe('File path or glob, relative to the workspace.'),
  }),
  async run({ path }, { cwd }) {
    const files = await expand(cwd, path)
    if (files.length === 0) return { content: `nothing matches ${path}` }

    const counted = await Promise.all(
      files.map(async (file) => {
        const text = await Bun.file(file).text()
        return { path: relative(cwd, file), ...count(text) }
      }),
    )

    const rows = counted.map(
      (file) =>
        `${file.path}: ${file.lines} lines, ${file.words} words, ${file.characters} characters`,
    )

    if (counted.length === 1) return { content: rows[0] as string }

    const total = counted.reduce(
      (sum, file) => ({
        lines: sum.lines + file.lines,
        words: sum.words + file.words,
        characters: sum.characters + file.characters,
      }),
      { lines: 0, words: 0, characters: 0 },
    )

    return {
      content: `${rows.join('\n')}\ntotal: ${total.lines} lines, ${total.words} words, ${
        total.characters
      } characters`,
    }
  },
})

/**
 * awk expressions that leave the program.
 *
 * Redirection (`>`, `>>`, `|`) writes files or starts a shell; `system()` and
 * `close()` do the same more plainly; `ENVIRON` reads the environment, which
 * is where the API keys are.
 *
 * Refusing on a pattern is refusing too much and never too little, which is
 * the right way round: a legitimate program that trips it can be run through
 * `bash`, where a person sees what it is, whereas one that slips through this
 * check runs unseen.
 */
const NOT_READING = [
  // Any redirection after a print, whatever it points at. Matching `> "name"`
  // alone misses `> name`, where awk resolves the variable at run time and
  // writes just the same — the check has to be about redirecting, not about
  // what the destination happens to look like. A bare `>`/`<` is a comparison
  // and stays allowed; only `print ... >` is a write.
  { pattern: /\bprintf?\b[^;}\n]*>/, because: 'writes to a file' },
  // A lone `|` is a pipe to or from a command; `||` is logical-or and stays.
  { pattern: /(?<!\|)\|(?!\|)/, because: 'pipes to or from a command' },
  // Every getline, whatever sits between the keyword and its source. The old
  // rule looked for `<` right after `getline` and so missed `getline v < f` —
  // a variable in between — which read a file outside the workspace. No
  // read-only use needs getline: it exists to read another file or a command.
  { pattern: /\bgetline\b/, because: 'reads a file or command of its own choosing' },
  { pattern: /\bsystem\s*\(/, because: 'runs a command' },
  { pattern: /\bclose\s*\(/, because: 'closes a stream it should not have opened' },
  { pattern: /\bENVIRON\b/, because: 'reads the environment, which holds the keys' },
]

export const awkTool = defineTool({
  name: 'awk',
  reads: true,
  description:
    'Run an awk program over a file and return what it prints. Read-only: only the -F and -v ' +
    'flags are allowed, and programs that redirect, pipe, call system() or use getline are ' +
    'refused — use bash or grep for those. Good for pulling a column or field out of text.',
  schema: z.object({
    program: z
      .string()
      .describe('The awk program, optionally preceded by flags such as -F, or -v name=value.'),
    path: z.string().describe('File to read, relative to the workspace.'),
  }),
  async run({ program, path }, { cwd, signal }) {
    // Flags first, because `-f script.awk` used to be accepted and awk then ran
    // a whole program from a file the agent wrote. Only -F and -v are read-only
    // flags; anything else is refused here before the program is even looked at.
    const parsed = splitFlags(program)
    if ('refusal' in parsed) return { content: parsed.refusal, isError: true }

    const refusal = NOT_READING.find((rule) => rule.pattern.test(parsed.body))
    if (refusal) {
      return {
        content: `refused: this awk program ${refusal.because}, and awk here only reads. Run it through bash if that is what you mean.`,
        isError: true,
      }
    }

    const file = resolveInWorkspace(cwd, path)

    // `--` ends option parsing, so the program is the program even if it starts
    // with `-`, and never a shell: the arguments are a model's output, and a
    // shell would give the quoting in them a second meaning. The body goes
    // through as one argument, so multi-line programs, `#` comments and
    // separators like `-F ,` survive instead of being split on whitespace.
    return await capture(['awk', ...parsed.flags, '--', parsed.body, file], cwd, signal)
  },
})

/**
 * Separates leading awk flags from the program, allowing only -F and -v.
 *
 * The program that follows is returned untouched, in one piece: it used to be
 * split on whitespace and rejoined, which folded multi-line programs onto one
 * line, made a `#` comment swallow everything after it, and turned `-F ,` and
 * `-v name=value` into gibberish. A flag other than -F or -v — `-f`, `-e`,
 * `--source`, any of them — is refused rather than passed on, because those are
 * the ones that run a program of the agent's choosing.
 */
function splitFlags(program: string): { flags: string[]; body: string } | { refusal: string } {
  const flags: string[] = []
  let rest = program

  for (;;) {
    const trimmed = rest.replace(/^\s+/, '')
    if (trimmed === '' || !trimmed.startsWith('-')) return { flags, body: trimmed }

    const match = trimmed.match(/^(-F|-v)([\s\S]*)$/)
    if (match === null) {
      const flag = trimmed.split(/\s/)[0]
      return {
        refusal:
          `refused: awk here accepts only the -F and -v flags, and "${flag}" is neither. ` +
          'Anything that runs a program of its own — -f, -e, --source — is refused, and awk ' +
          'here only reads. Run it through bash if that is what you mean.',
      }
    }

    const name = match[1] as string
    const tail = match[2] as string
    if (/^\S/.test(tail)) {
      // Value attached to the flag, as in `-F,` or `-vname=value`.
      const value = tail.match(/^(\S*)([\s\S]*)$/) as RegExpMatchArray
      flags.push(name + (value[1] as string))
      rest = value[2] as string
    } else {
      // Value in the next word, as in `-F ,` or `-v name=value`.
      const value = tail.match(/^\s+(\S+)([\s\S]*)$/)
      if (value === null) {
        // A trailing flag with nothing after it — let awk say what is wrong.
        flags.push(name)
        return { flags, body: '' }
      }
      flags.push(name, value[1] as string)
      rest = value[2] as string
    }
  }
}

export const lsofTool = defineTool({
  name: 'lsof',
  reads: true,
  description:
    'Find which process is listening on a TCP port. Use it when a server will not start ' +
    'because the port is taken, to learn what is holding it.',
  schema: z.object({
    port: z.number().int().min(1).max(65_535).describe('TCP port to look up.'),
  }),
  async run({ port }, { cwd, signal }) {
    // Only the listeners on one port. `lsof` with a wider question lists every
    // file every process on the machine has open, which is both enormous and
    // nobody's business here.
    const result = await capture(['lsof', '-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], cwd, signal)

    // lsof exits non-zero when it finds nothing, which is an answer rather
    // than a failure.
    if (result.isError === true || result.content.trim() === '') {
      return { content: `nothing is listening on port ${port}` }
    }
    return result
  },
})

/** Runs a program with fixed arguments and returns what it printed. */
async function capture(
  argv: string[],
  cwd: string,
  signal: AbortSignal,
): Promise<{ content: string; isError?: boolean }> {
  const name = argv[0] as string

  let child: ReturnType<typeof Bun.spawn>
  try {
    child = Bun.spawn(argv, {
      cwd,
      stdout: 'pipe',
      stderr: 'pipe',
      // Nothing inherited: the environment holds the API keys, and no program
      // run here has any business reading them.
      env: { PATH: process.env.PATH ?? '/usr/bin:/bin' },
      signal,
    })
  } catch {
    return { content: `${name} is not available on this machine`, isError: true }
  }

  const timeout = setTimeout(() => child.kill(), TIMEOUT_MS)
  const [out, err, code] = await Promise.all([
    new Response(child.stdout as ReadableStream<Uint8Array>).text(),
    new Response(child.stderr as ReadableStream<Uint8Array>).text(),
    child.exited,
  ])
  clearTimeout(timeout)

  if (code !== 0) {
    const complaint = err.trim() || out.trim()
    return {
      content: complaint === '' ? `${name} exited ${code}` : complaint,
      isError: true,
    }
  }

  const text = out.trimEnd()
  return {
    content:
      text.length > MAX_OUTPUT
        ? `${text.slice(0, MAX_OUTPUT)}\n... truncated at ${MAX_OUTPUT} characters`
        : text,
  }
}

/** Every workspace file a path or glob names. */
async function expand(cwd: string, path: string): Promise<string[]> {
  const looksLikeGlob = /[*?[\]{}]/.test(path)
  if (!looksLikeGlob) {
    const resolved = resolveInWorkspace(cwd, path)
    return (await Bun.file(resolved).exists()) ? [resolved] : []
  }

  // Resolved before scanning, so a glob cannot walk out of the workspace the
  // way a path cannot.
  resolveInWorkspace(cwd, path.replace(/[*?[\]{}].*$/, '') || '.')

  const found: string[] = []
  for await (const file of new Bun.Glob(path).scan({ cwd, absolute: true, onlyFiles: true })) {
    found.push(file)
  }
  return found.sort()
}

/** Lines, words and characters, counted the way `wc` counts them. */
function count(text: string): { lines: number; words: number; characters: number } {
  const withoutTrailer = text.endsWith('\n') ? text.slice(0, -1) : text
  return {
    // A file with no trailing newline still ends in a line; an empty file has
    // none at all.
    lines: withoutTrailer === '' ? 0 : withoutTrailer.split('\n').length,
    words: text.split(/\s+/).filter((word) => word !== '').length,
    characters: text.length,
  }
}
