export type PromptContext = {
  cwd: string
  platform: string
  /** Contents of the project's instruction files, in the order they were found. */
  instructions?: string[]
  /** Names and descriptions of available skills; bodies are fetched on demand. */
  skillIndex?: string
}

/**
 * The base system prompt.
 *
 * It is deliberately short, and a test fails if it crosses 1000 tokens. Every
 * token here is paid on every request of every turn of every agent, and
 * anything that is only sometimes relevant belongs in a skill the model loads
 * when it needs it — not here.
 *
 * Adding a rule to this prompt is the easiest way to make the project worse.
 */
const BASE = `You are a coding agent working in a terminal on a real codebase.

Work by making changes, not by describing them. Read before you edit, and
check your work by running it: tests, a build, the program itself.

Prefer targeted commands over ones that print whole files. Read a file before
editing it — edits match exact text, and you cannot match what you have not
seen.

Ask for everything you need at once. Reads and searches that do not depend on
each other belong in the same turn: each turn sends the whole conversation
again, so ten separate lookups cost ten times what one round of ten costs.

When something fails, read the actual error before changing anything. Do not
guess at a fix and do not paper over a failure by weakening a test.

Match the surrounding code: its naming, its idioms, its comment density. Do
not add dependencies or abstractions the task does not need.

Be concise. The user is reading a terminal, not a report. Say what you did and
what it did, not what you are about to do.`

export function buildSystemPrompt(context: PromptContext): string {
  const sections = [BASE, `Working directory: ${context.cwd}\nPlatform: ${context.platform}`]

  const instructions = context.instructions?.filter((text) => text.trim() !== '') ?? []
  if (instructions.length > 0) {
    // Last, so a project can override anything above without the base prompt
    // having to anticipate it.
    sections.push(`Project instructions:\n\n${instructions.join('\n\n')}`)
  }

  if (context.skillIndex && context.skillIndex.trim() !== '') {
    sections.push(context.skillIndex)
  }

  return sections.join('\n\n')
}
