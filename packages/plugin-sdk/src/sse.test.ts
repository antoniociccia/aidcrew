import { describe, expect, test } from 'bun:test'
import { parseSse } from './sse.ts'

const encoder = new TextEncoder()

async function* bytes(chunks: string[]): AsyncIterable<Uint8Array> {
  for (const chunk of chunks) yield encoder.encode(chunk)
}

async function collect(chunks: string[]): Promise<string[]> {
  const out: string[] = []
  for await (const event of parseSse(bytes(chunks))) out.push(event)
  return out
}

describe('parseSse', () => {
  test('yields the data of each event', async () => {
    expect(await collect(['data: one\n\ndata: two\n\n'])).toEqual(['one', 'two'])
  })

  test('reassembles an event split across network chunks', async () => {
    // The single most common source of parser bugs: TCP splits wherever it
    // likes, including mid-token and mid-delimiter.
    expect(await collect(['data: {"a"', ':1}\n', '\ndata: {"b":2}\n\n'])).toEqual([
      '{"a":1}',
      '{"b":2}',
    ])
  })

  test('joins the data lines of a multi-line event with newlines', async () => {
    expect(await collect(['data: first\ndata: second\n\n'])).toEqual(['first\nsecond'])
  })

  test('ignores comment lines used as keep-alives', async () => {
    expect(await collect([': ping\n\ndata: real\n\n'])).toEqual(['real'])
  })

  test('ignores fields other than data', async () => {
    expect(await collect(['event: message\nid: 1\ndata: payload\n\n'])).toEqual(['payload'])
  })

  test('accepts crlf line endings', async () => {
    expect(await collect(['data: one\r\n\r\n'])).toEqual(['one'])
  })

  test('keeps two events apart when a crlf is cut between chunks', async () => {
    // A `\r` at the end of one chunk and its `\n` at the start of the next
    // is a delimiter the network happened to cut in half, and cutting it in
    // half is exactly what the network does. Normalising each chunk on its
    // own leaves the `\r` stranded, the blank line is never seen, and two
    // events arrive as one — with two JSON documents in it.
    expect(await collect(['data: {"a":1}\r\n\r', '\ndata: {"b":2}\r\n\r\n'])).toEqual([
      '{"a":1}',
      '{"b":2}',
    ])
  })

  test('tolerates data without the conventional space after the colon', async () => {
    expect(await collect(['data:tight\n\n'])).toEqual(['tight'])
  })

  test('emits a trailing event that never got its blank line', async () => {
    expect(await collect(['data: last\n'])).toEqual(['last'])
  })

  test('skips empty events', async () => {
    expect(await collect(['\n\n\n\ndata: real\n\n'])).toEqual(['real'])
  })

  test('does not split a multi-byte character across chunks', async () => {
    const raw = encoder.encode('data: caffè\n\n')
    const split = [raw.slice(0, 11), raw.slice(11)]
    async function* halves() {
      for (const part of split) yield part
    }

    const out: string[] = []
    for await (const event of parseSse(halves())) out.push(event)

    expect(out).toEqual(['caffè'])
  })
})
