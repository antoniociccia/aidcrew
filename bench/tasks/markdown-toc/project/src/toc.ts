export type Heading = { level: number; text: string; slug: string }

/** The headings of a markdown document, in order, with anchor slugs. */
export function toc(markdown: string): Heading[] {
  throw new Error(`toc is not implemented yet (${markdown.length} characters)`)
}
