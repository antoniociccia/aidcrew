/**
 * The tool that would have done this without a shell.
 *
 * The description already says to use `read`, `grep`, `glob` and `wc` instead
 * — and a description is read once, before choosing, in competition with every
 * other description on the request. Measured in a real session: fifty-two
 * `bash` calls against nine `read` ones, for work that was all reading.
 *
 * A tool result is read at the moment it matters, by a model that has just
 * done the thing and is deciding what to do next. So the answer goes there,
 * once, as a sentence rather than a scolding — and only when the whole command
 * is plainly one of these, because a note on a command it half-matches is
 * noise, and noise is what gets skimmed past.
 */

const INSTEAD: { pattern: RegExp; use: string; why: string }[] = [
  {
    pattern: /^\s*(cat|bat)\s+[^|;&<>]+$/,
    use: 'read',
    why: 'it needs no approval and gives you line numbers',
  },
  {
    pattern: /^\s*(head|tail)\s+[^|;&<>]+$/,
    use: 'head',
    why: 'it needs no approval and says how many lines the file has',
  },
  {
    pattern: /^\s*git\s+log\b[^|;&<>]*$/,
    use: 'git-log',
    why: 'it needs no approval and comes back parsed',
  },
  {
    pattern:
      /^\s*(tree\b[^|;&<>]*|ls\s+-[a-zA-Z]*R[a-zA-Z]*\b[^|;&<>]*|find\s+[^|;&<>]*-type\s+d[^|;&<>]*)$/,
    use: 'tree',
    why: 'it skips build output, stops at a depth, and needs no approval',
  },
  {
    pattern: /^\s*(stat|du|file)\s+[^|;&<>]+$/,
    use: 'stat',
    why: 'it needs no approval and says whether a file is worth reading',
  },
  {
    pattern: /^\s*(grep|rg|ag)\s+[^|;&<>]+$/,
    use: 'grep',
    why: 'it skips build output and needs no approval',
  },
  {
    pattern: /^\s*(find|fd)\s+[^|;&<>]+$/,
    use: 'glob',
    why: 'it skips build output and needs no approval',
  },
  { pattern: /^\s*wc\s+[^|;&<>]+$/, use: 'wc', why: 'it needs no approval' },
  {
    pattern: /^\s*ls\s+[^|;&<>]*$/,
    use: 'glob',
    why: 'it needs no approval and skips build output',
  },
]

/**
 * A line to add to the result, or nothing.
 *
 * Nothing for a pipe or a redirection: the shell is then doing work no tool
 * here does, and saying otherwise would be wrong.
 *
 * Commands joined with `&&` or `;` are looked at one at a time, because that
 * is two commands rather than one clever one — and two reads joined by one is
 * exactly the shape somebody exploring reaches for. Treating it as opaque
 * meant the habit this exists to redirect was the habit it never saw: forty
 * calls in a turn, nearly all `cat a && cat b`, not one of them told there was
 * a better tool.
 *
 * Every part has to be one of these, or nothing is said. A read with a build
 * attached to it is not a read.
 */
export function insteadOf(command: string): string | undefined {
  if (/[|<>]/.test(command)) return undefined

  const parts = command
    .split(/&&|;/)
    .map((part) => part.trim())
    .filter((part) => part !== '')
  if (parts.length === 0) return undefined

  let first: { use: string; why: string } | undefined
  for (const [at, part] of parts.entries()) {
    // An echo between two reads is somebody labelling their own output —
    // punctuation, not a third thing being done. An echo at the end is the
    // result: `grep x a.ts && echo found` asks the shell a question, and
    // answering it is composition rather than reading.
    if (/^echo\s/.test(part) && at < parts.length - 1) continue

    const found = INSTEAD.find(({ pattern }) => pattern.test(part))
    if (!found) return undefined
    first ??= { use: found.use, why: found.why }
  }

  if (!first) return undefined
  return `\n\n(\`${first.use}\` would have done this: ${first.why}.)`
}
