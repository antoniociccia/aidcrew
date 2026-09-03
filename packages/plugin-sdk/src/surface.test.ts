import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { serveToPlugins } from '@aidcrew/core'

/**
 * The one import a plugin author should need.
 *
 * A plugin written against this package alone must compile and run. Until
 * this existed, every bundled provider reached into `@aidcrew/core` for the
 * errors it is meant to throw, which meant the documented contract — "drop a
 * module in, import the SDK" — was not the contract the code actually had.
 */
describe('everything a plugin needs, from one package', () => {
  test('a provider plugin can be written with only the SDK', async () => {
    const sdk = await import('./index.ts')

    // What a provider is built and declared with.
    expect(typeof sdk.definePlugin).toBe('function')
    expect(typeof sdk.defineProvider).toBe('function')
    expect(typeof sdk.defineTool).toBe('function')

    // What it throws when the service misbehaves. A provider that invents its
    // own error classes cannot be told apart from a bug in the harness.
    expect(typeof sdk.ProviderResponseError).toBe('function')
    expect(typeof sdk.ProviderProtocolError).toBe('function')

    // What it needs to read a stream and to fake tool calling.
    expect(typeof sdk.parseSse).toBe('function')
    expect(typeof sdk.withPromptedTools).toBe('function')
    expect(typeof sdk.accumulate).toBe('function')
  })

  test('a plugin importing only the SDK actually loads', async () => {
    // Served explicitly: outside a running host nothing resolves the name,
    // which is exactly why serveToPlugins exists. Relying on some other test
    // in the same run having built a host is how a suite passes together and
    // fails one file at a time.
    const sdk = await import('./index.ts')
    serveToPlugins({ '@aidcrew/plugin-sdk': sdk, zod: await import('zod') })

    const dir = mkdtempSync(join(tmpdir(), 'aidcrew-sdk-only-'))
    writeFileSync(
      join(dir, 'index.ts'),
      `import { definePlugin, defineTool, ProviderResponseError } from '@aidcrew/plugin-sdk'
       import { z } from 'zod'
       export default definePlugin({
         name: 'sdk-only',
         tools: [
           defineTool({
             name: 'shout',
             description: 'Upper-cases a word.',
             schema: z.object({ word: z.string() }),
             async run({ word }) {
               if (word === '') throw new ProviderResponseError('nothing to shout', 'sdk-only')
               return { content: word.toUpperCase() }
             },
           }),
         ],
       })`,
    )

    const loaded = (await import(join(dir, 'index.ts'))) as { default: { name: string } }
    expect(loaded.default.name).toBe('sdk-only')
  })
})
