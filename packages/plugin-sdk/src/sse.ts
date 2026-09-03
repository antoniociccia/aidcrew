/**
 * Server-sent events, reduced to what an LLM stream actually uses: the data
 * payload of each event.
 *
 * Two details cause most streaming bugs, and both are handled here. Network
 * chunks split at arbitrary byte offsets — including in the middle of the
 * blank-line delimiter and in the middle of a multi-byte character — so the
 * decoder runs in streaming mode and events are only emitted once their
 * delimiter has actually arrived.
 *
 * The same goes for a CRLF: the `\r` can end one chunk and the `\n` begin the
 * next, so line endings are normalised on the buffer as a whole and never on a
 * chunk alone. Done per chunk, the stranded `\r` hid the blank line between
 * two events, and the two arrived as one — with two JSON documents in it.
 */
export async function* parseSse(source: AsyncIterable<Uint8Array>): AsyncIterable<string> {
  const decoder = new TextDecoder()
  let buffer = ''

  for await (const chunk of source) {
    buffer = (buffer + decoder.decode(chunk, { stream: true })).replaceAll('\r\n', '\n')

    for (;;) {
      const boundary = buffer.indexOf('\n\n')
      if (boundary === -1) break

      const event = dataOf(buffer.slice(0, boundary))
      buffer = buffer.slice(boundary + 2)
      if (event !== undefined) yield event
    }
  }

  // Some servers close the connection without a final blank line.
  buffer = (buffer + decoder.decode()).replaceAll('\r\n', '\n')
  const last = dataOf(buffer)
  if (last !== undefined) yield last
}

/** Returns the joined `data:` lines of one event, or undefined if it had none. */
function dataOf(event: string): string | undefined {
  const lines = event
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => {
      const value = line.slice('data:'.length)
      // The space after the colon is conventional, not part of the payload.
      return value.startsWith(' ') ? value.slice(1) : value
    })

  return lines.length === 0 ? undefined : lines.join('\n')
}
