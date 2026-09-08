import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { CanonicalRequest, StreamDelta } from '@aidcrew/core'
import { createReplayProvider } from './replay.ts'
import { buildRequestBody } from './request.ts'

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'aidcrew-replay-'))
})

afterEach(() => rmSync(dir, { recursive: true, force: true }))

const ask = (text: string, model = 'glm-5.3-flash'): CanonicalRequest => ({
  model,
  system: 'You are a test.',
  messages: [{ role: 'user', content: [{ type: 'text', text }] }],
  tools: [],
  maxTokens: 100,
})

/** Records what AIDCREW_TRACE_DIR would have: the wire body, and the raw stream. */
function record(stem: string, request: CanonicalRequest, sse: string): void {
  writeFileSync(join(dir, `${stem}.request.json`), JSON.stringify(buildRequestBody(request)))
  writeFileSync(join(dir, `${stem}.response.sse`), sse)
}

const said = (text: string) =>
  `data: {"choices":[{"index":0,"delta":{"content":${JSON.stringify(text)}},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n`

async function collect(stream: AsyncIterable<StreamDelta>): Promise<StreamDelta[]> {
  const out: StreamDelta[] = []
  for await (const delta of stream) out.push(delta)
  return out
}

describe('a provider that answers from a trace', () => {
  test('gives a recorded request its recorded stream, through the same parser', async () => {
    record('001', ask('what is 2+2?'), said('4'))
    const provider = createReplayProvider({ dir })

    const deltas = await collect(provider.send(ask('what is 2+2?'), new AbortController().signal))

    expect(deltas.find((delta) => delta.type === 'text_delta')).toEqual({
      type: 'text_delta',
      text: '4',
    })
    expect(deltas.at(-1)?.type).toBe('done')
  })

  test('answers each recording once, in order, so a turn asked twice gets its second answer', async () => {
    record('001', ask('go'), said('first'))
    record('002', ask('go'), said('second'))
    const provider = createReplayProvider({ dir })

    const first = await collect(provider.send(ask('go'), new AbortController().signal))
    const second = await collect(provider.send(ask('go'), new AbortController().signal))

    const text = (deltas: StreamDelta[]) => deltas.find((d) => d.type === 'text_delta')
    expect(text(first)).toEqual({ type: 'text_delta', text: 'first' })
    expect(text(second)).toEqual({ type: 'text_delta', text: 'second' })
  })

  test('falls back to the next recording for the model when the messages differ', async () => {
    // Prompts drift between the run that was recorded and the run replaying
    // it — a date in the briefing, a path — and a replay that refused every
    // drift would replay nothing.
    record('001', ask('the recorded wording'), said('still me'))
    const provider = createReplayProvider({ dir })

    const deltas = await collect(
      provider.send(ask('a slightly different wording'), new AbortController().signal),
    )

    expect(deltas.find((d) => d.type === 'text_delta')).toEqual({
      type: 'text_delta',
      text: 'still me',
    })
  })

  test('refuses to improvise: a model the trace never saw is an error naming the directory', async () => {
    record('001', ask('go', 'other-model'), said('x'))
    const provider = createReplayProvider({ dir })

    const failing = collect(provider.send(ask('go'), new AbortController().signal))

    await expect(failing).rejects.toThrow(/no recorded answer for glm-5.3-flash/)
    await expect(failing).rejects.toThrow(dir)
  })
})
