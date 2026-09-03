import { describe, expect, test } from 'bun:test'
import { explain, remembering } from './body.ts'

const encoder = new TextEncoder()

function bytes(...chunks: string[]): AsyncIterable<Uint8Array> {
  return (async function* () {
    for (const chunk of chunks) yield encoder.encode(chunk)
  })()
}

describe('remembering a body as it goes by', () => {
  test('passes every chunk through untouched', async () => {
    const body = remembering(bytes('data: a\n\n', 'data: b\n\n'))

    const seen: string[] = []
    for await (const chunk of body.bytes) seen.push(new TextDecoder().decode(chunk))

    expect(seen).toEqual(['data: a\n\n', 'data: b\n\n'])
  })

  test('can say afterwards what went by, as text', async () => {
    const body = remembering(bytes('{"error":', '{"message":"caffè"}}'))

    for await (const _ of body.bytes) {
      // drained
    }

    expect(body.text()).toBe('{"error":{"message":"caffè"}}')
  })

  test('keeps only the start of a long body', async () => {
    // The copy exists for a failure that arrives in a few hundred bytes; a
    // stream that is fine must not be held twice for its whole length.
    const chunk = 'x'.repeat(32 * 1024)
    const body = remembering(bytes(chunk, chunk, chunk, chunk))

    for await (const _ of body.bytes) {
      // drained
    }

    expect(body.text().length).toBeLessThan(3 * 32 * 1024)
  })
})

describe('explaining a body', () => {
  test('finds the sentence inside the envelopes gateways use', () => {
    expect(explain('{"error":{"message":"Insufficient balance."}}')).toBe('Insufficient balance.')
    expect(explain('{"error":"Invalid API key."}')).toBe('Invalid API key.')
    expect(explain('{"message":"Not found."}')).toBe('Not found.')
  })

  test('has nothing to say about a body that is not json', () => {
    expect(explain('gateway timeout')).toBeUndefined()
  })
})
