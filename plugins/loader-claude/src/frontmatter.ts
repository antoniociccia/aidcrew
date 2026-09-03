import { parse } from 'yaml'

export type Frontmatter = {
  data: Record<string, unknown>
  body: string
}

const FENCE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/

/**
 * Splits a markdown file into its YAML frontmatter and its body.
 *
 * Real frontmatter uses the whole of YAML — folded scalars, quoted strings
 * with escapes, inline arrays — so this parses it properly instead of matching
 * `key: value` lines. A file with no frontmatter, or with frontmatter that
 * does not parse, returns no data rather than throwing: one malformed skill
 * should not stop a session from starting.
 */
export function splitFrontmatter(source: string): Frontmatter {
  const match = FENCE.exec(source)
  if (!match?.[1]) return { data: {}, body: source.trim() }

  const body = source.slice(match[0].length).trim()

  try {
    const parsed = parse(match[1]) as unknown
    const data =
      typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {}
    return { data, body }
  } catch {
    return { data: {}, body }
  }
}

/** Reads a field that must be a non-empty string. */
export function stringField(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key]
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed === '' ? undefined : trimmed
}

/**
 * Reads a list written either as a YAML array or as a comma-separated string,
 * because both spellings appear in the wild.
 */
export function listField(data: Record<string, unknown>, key: string): string[] | undefined {
  const value = data[key]

  if (Array.isArray(value)) {
    const items = value.filter((item): item is string => typeof item === 'string')
    return items.length === 0 ? undefined : items
  }

  if (typeof value === 'string') {
    const items = value
      .split(',')
      .map((item) => item.trim())
      .filter((item) => item !== '')
    return items.length === 0 ? undefined : items
  }

  return undefined
}
