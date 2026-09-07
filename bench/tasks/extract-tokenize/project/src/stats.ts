/** How many words the text has. */
export function wordCount(text: string): number {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word !== '').length
}

/** The n most frequent words, most frequent first. */
export function topWords(text: string, n: number): [string, number][] {
  const counts = new Map<string, number>()
  for (const word of text.split(/\s+/)) {
    const cleaned = word.replace(/[^A-Za-z0-9']/g, '')
    if (cleaned === '') continue
    counts.set(cleaned, (counts.get(cleaned) ?? 0) + 1)
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, n)
}
