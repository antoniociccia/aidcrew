import { describe, expect, test } from 'bun:test'
import { listOpenAiModels } from './models.ts'

describe('asking an openai-shaped endpoint what it has', () => {
  test('reads the ids out of the catalogue', async () => {
    let seen: { url: string; headers: Record<string, string> } | undefined
    const fetchImpl = async (url: string, init: RequestInit) => {
      seen = { url, headers: init.headers as Record<string, string> }
      return new Response(JSON.stringify({ data: [{ id: 'a' }, { id: 'b' }, {}] }), { status: 200 })
    }

    const models = await listOpenAiModels(
      { baseUrl: 'https://x/v1/', apiKey: 'k', fetchImpl },
      new AbortController().signal,
    )

    expect(models).toEqual(['a', 'b'])
    expect(seen?.url).toBe('https://x/v1/models')
    expect(seen?.headers.Authorization).toBe('Bearer k')
  })

  test('says the key was rejected rather than showing nothing', async () => {
    const fetchImpl = async () => new Response('no', { status: 401 })

    expect(
      listOpenAiModels(
        { baseUrl: 'https://x/v1', apiKey: 'k', fetchImpl },
        new AbortController().signal,
      ),
    ).rejects.toThrow(/key/i)
  })
})
