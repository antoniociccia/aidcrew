export type Heading = { level: number; text: string; slug: string }

/** The headings of a markdown document, in order, with anchor slugs. */
export function toc(markdown: string): Heading[] {
  const headings: Heading[] = []
  const used = new Map<string, number>()
  let fenced = false
  for (const line of markdown.split(/\r?\n/)) {
    if (/^\s*```/.test(line)) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    const match = /^(#{1,6}) +(.*?)\s*$/.exec(line)
    if (!match) continue
    const text = match[2] ?? ''
    const base = text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
    const seen = used.get(base) ?? 0
    used.set(base, seen + 1)
    headings.push({
      level: (match[1] ?? '#').length,
      text,
      slug: seen === 0 ? base : `${base}-${seen + 1}`,
    })
  }
  return headings
}
