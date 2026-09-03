import { describe, expect, test } from 'bun:test'
import type { CanonicalRequest } from '@aidcrew/core'
import { buildRequestBody } from './request.ts'

function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'test-model',
    system: 'Be brief.',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }],
    tools: [],
    maxTokens: 1024,
    ...overrides,
  }
}

describe('buildRequestBody', () => {
  test('sends the system prompt as the first message', () => {
    const body = buildRequestBody(request())

    expect(body.messages[0]).toEqual({ role: 'system', content: 'Be brief.' })
    expect(body.model).toBe('test-model')
    expect(body.max_tokens).toBe(1024)
  })

  test('always streams and asks for usage, which is otherwise omitted', () => {
    const body = buildRequestBody(request())

    expect(body.stream).toBe(true)
    expect(body.stream_options).toEqual({ include_usage: true })
  })

  test('omits the system message when there is no system prompt', () => {
    const body = buildRequestBody(request({ system: '' }))

    expect(body.messages[0]).toEqual({ role: 'user', content: 'hi' })
  })

  test('turns an assistant tool call into tool_calls with stringified arguments', () => {
    const body = buildRequestBody(
      request({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Looking.' },
              { type: 'tool_use', id: 'c1', name: 'read', input: { path: 'a.ts' } },
            ],
          },
        ],
      }),
    )

    expect(body.messages[1]).toEqual({
      role: 'assistant',
      content: 'Looking.',
      tool_calls: [
        {
          id: 'c1',
          type: 'function',
          function: { name: 'read', arguments: '{"path":"a.ts"}' },
        },
      ],
    })
  })

  test('splits tool results into one tool message each', () => {
    const body = buildRequestBody(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'c1', content: 'ok', isError: false },
              { type: 'tool_result', toolUseId: 'c2', content: 'boom', isError: true },
            ],
          },
        ],
      }),
    )

    expect(body.messages.slice(1)).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'tool', tool_call_id: 'c2', content: 'boom' },
    ])
  })

  test('drops thinking blocks, which cannot be sent back', () => {
    const body = buildRequestBody(
      request({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'hmm' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      }),
    )

    expect(body.messages[1]).toEqual({ role: 'assistant', content: 'answer' })
  })

  test('declares tools in the function-calling shape', () => {
    const body = buildRequestBody(
      request({
        tools: [
          {
            name: 'read',
            description: 'Read a file.',
            inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          },
        ],
      }),
    )

    expect(body.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'read',
          description: 'Read a file.',
          parameters: { type: 'object', properties: { path: { type: 'string' } } },
        },
      },
    ])
  })

  test('omits the tools field entirely when there are none', () => {
    // Several OpenAI-compatible gateways reject an empty tools array.
    expect(buildRequestBody(request()).tools).toBeUndefined()
  })

  test('passes temperature through only when it was set', () => {
    expect(buildRequestBody(request()).temperature).toBeUndefined()
    expect(buildRequestBody(request({ temperature: 0.2 })).temperature).toBe(0.2)
  })
})
