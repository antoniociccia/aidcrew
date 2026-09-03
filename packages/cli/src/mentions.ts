import { relative } from 'node:path'
import { resolveInWorkspace } from '@aidcrew/tool-fs'

/**
 * Naming a file in a message, with `@`.
 *
 * Without it, telling an agent about a file means describing it and hoping —
 * and the agent then spends a turn, and a whole request, finding what you
 * already had open. Naming it directly costs one read that nobody is billed a
 * round trip for, and it is the difference between "look at the auth guard"
 * and pointing at it.
 *
 * The file is attached rather than merely named: a path in a sentence is
 * something the model has to go and fetch, which is the turn this exists to
 * avoid.
 */

/** Enough of a file to be worth attaching, not enough to fill a window. */
const MAX_BYTES = 100_000
const MAX_FILES = 10

/**
 * Paths mentioned with `@`.
 *
 * Stops at whitespace, and at the punctuation that ends a sentence rather than
 * a filename — `@src/auth.ts.` is a file and a full stop, and attaching
 * nothing because of the full stop would be maddening.
 */
export function mentions(text: string): string[] {
  const found: string[] = []

  // Quoted, the name may hold a space: `@"docs/my plan.md"`. That is how the
  // finder writes such a file in, because unquoted it stopped at the space
  // and the message went out saying it could not read `docs/my`.
  for (const match of text.matchAll(/(^|\s)@(?:"([^"]+)"|([^\s@]+))/g)) {
    const path = match[2] ?? (match[3] ?? '').replace(/[.,;:!?)\]}]+$/, '')
    if (path !== '' && !found.includes(path)) found.push(path)
  }

  return found.slice(0, MAX_FILES)
}

/** A file's name as it is written into a message, quoted when it has to be. */
export function mentionOf(path: string): string {
  return /\s/.test(path) ? `@"${path}"` : `@${path}`
}

export type Attachment = { path: string; text: string; truncated: boolean }

export type Attached = {
  /** The message as it should be sent, with the files after it. */
  text: string
  attached: Attachment[]
  /** Mentions that are not files here, so the person can be told plainly. */
  missing: string[]
}

/**
 * Reads what a message names and puts it after the message.
 *
 * After rather than before: what you asked is the point, and a model that
 * meets four files before the question reads the question as being about the
 * last of them.
 */
export async function attach(text: string, cwd: string): Promise<Attached> {
  const attached: Attachment[] = []
  const missing: string[] = []

  for (const path of mentions(text)) {
    let resolved: string
    try {
      resolved = resolveInWorkspace(cwd, path)
    } catch {
      // Outside the workspace. Named rather than read, and the agent can ask.
      missing.push(path)
      continue
    }

    const file = Bun.file(resolved)
    if (!(await file.exists())) {
      missing.push(path)
      continue
    }

    const whole = await file.text().catch(() => undefined)
    if (whole === undefined) {
      missing.push(path)
      continue
    }

    const truncated = whole.length > MAX_BYTES
    attached.push({
      path: relative(cwd, resolved) || path,
      text: truncated ? whole.slice(0, MAX_BYTES) : whole,
      truncated,
    })
  }

  if (attached.length === 0) return { text, attached, missing }

  const blocks = attached.map(
    (file) =>
      `<file path="${file.path}">\n${file.text}${file.truncated ? '\n… truncated' : ''}\n</file>`,
  )

  return { text: `${text}\n\n${blocks.join('\n\n')}`, attached, missing }
}
