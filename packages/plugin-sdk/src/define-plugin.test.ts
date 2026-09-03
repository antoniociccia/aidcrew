import { describe, expect, test } from 'bun:test'
import { CONTRACT } from '@aidcrew/core'
import { z } from 'zod'
import { definePlugin, defineProvider } from './define-plugin.ts'

describe('the contract number', () => {
  test('is stamped by the SDK, so the author never types it', () => {
    // Kept in the one place that knows it: the SDK the plugin compiled
    // against. Asked for, it goes stale; typed, it is wrong.
    expect(definePlugin({ name: 'stamped' }).contract).toBe(CONTRACT)
  })

  test('a plugin that says one keeps it, because it may be older on purpose', () => {
    expect(definePlugin({ name: 'pinned', contract: 1 }).contract).toBe(1)
  })
})

describe('a provider that can say which models it has', () => {
  const spec = {
    id: 'demo',
    configSchema: z.object({ apiKey: z.string().min(1, 'is required') }),
    create: () => ({ id: 'demo', send: async function* () {} }),
  }

  test('carries the listing through to the host', async () => {
    // Model discovery used to live outside the contract, as a `GET /models`
    // with a bearer token written down in two places. That works for the
    // OpenAI-shaped services and for nobody else: anthropic wants a different
    // header on a different path, so its users got a blank field and typed the
    // id from memory — which is the mistake this whole feature exists to stop.
    const definition = defineProvider({
      ...spec,
      listModels: async () => ['one', 'two'],
    })

    expect(await definition.listModels?.({ apiKey: 'k' }, new AbortController().signal)).toEqual([
      'one',
      'two',
    ])
  })

  test('validates the config before listing, as create does', async () => {
    const definition = defineProvider({
      ...spec,
      listModels: async () => ['one'],
    })

    const listing = definition.listModels?.({}, new AbortController().signal)

    expect(listing).rejects.toThrow(/invalid configuration for provider "demo".*apiKey/s)
    // And never the config itself, which is where the key would be.
    expect(listing).rejects.not.toThrow(/secret/)
  })

  test('is absent on a provider that cannot answer', () => {
    // A service billed flat may publish no catalogue at all, and pretending
    // otherwise would make the interface show an empty list rather than the
    // free-text field that actually works there.
    expect(defineProvider(spec).listModels).toBeUndefined()
  })
})
