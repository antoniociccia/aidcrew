/** The text in lines of at most width characters. */
export function wrap(text: string, width: number): string {
  if (!Number.isInteger(width) || width < 1)
    throw new RangeError(`width must be 1 or more, got ${width}`)
  const paragraphs = text.split(/\n\s*\n/)
  return paragraphs
    .map((paragraph) => {
      const lines: string[] = []
      let line = ''
      for (const word of paragraph.split(/\s+/).filter((one) => one !== '')) {
        let rest = word
        while (rest.length > width) {
          if (line !== '') {
            lines.push(line)
            line = ''
          }
          lines.push(rest.slice(0, width))
          rest = rest.slice(width)
        }
        if (line === '') line = rest
        else if (line.length + 1 + rest.length <= width) line = `${line} ${rest}`
        else {
          lines.push(line)
          line = rest
        }
      }
      if (line !== '') lines.push(line)
      return lines.join('\n')
    })
    .join('\n\n')
}
