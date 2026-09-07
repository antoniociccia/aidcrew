import { tokenize } from './tokenize.ts'

/** How many words the text has. */
export function wordCount(text: string): number {
  return tokenize(text).length
}

/** The n most frequent words, most frequent first. */
export function topWords(text: string, n: number): [string, number][] {
  const counts = new Map<string, number>()
  for (const word of tokenize(text)) counts.set(word, (counts.get(word) ?? 0) + 1)
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .slice(0, n)
}
