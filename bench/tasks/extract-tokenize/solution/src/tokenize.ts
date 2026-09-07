/** The words of a text, lower case: runs of letters, digits and apostrophes. */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9']+/)
    .filter((word) => word !== '')
}
