import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

const root = join(import.meta.dir, '..', '..', '..')
const read = (path: string) => readFileSync(join(root, path), 'utf8')

/**
 * Every provider either asks for caching or reports it, and none is silent.
 *
 * A measured session sent two million input tokens to write one plugin — the
 * same forty-thousand-token conversation, fifty times. That is what an agent
 * loop costs without caching, and it is the single largest number in the
 * system.
 *
 * The two halves are different per service and both were missing somewhere.
 * Anthropic holds a prefix only when the request says so, and nothing ever
 * said so. The OpenAI dialect does it on its own and reports it, and nothing
 * read the report — so a session that may already have been cached looked
 * like it paid full price, and there was no way to tell which.
 *
 * Kept as one test across all four because the next provider will have the
 * same two halves and no reason to think of either.
 */
describe('every provider and the cost of saying the same thing again', () => {
  test('anthropic asks, because nothing is held there unless it does', () => {
    const source = read('plugins/provider-anthropic/src/request.ts')

    expect(source).toContain('cache_control')
  })

  test('anthropic counts what it was given back', () => {
    const source = read('plugins/provider-anthropic/src/stream.ts')

    expect(source).toContain('cache_read_input_tokens')
    expect(source).toContain('cache_creation_input_tokens')
  })

  test('the OpenAI dialect counts what the service cached on its own', () => {
    // No asking here — it happens without being told — so the whole job is
    // reading the report, and it read `prompt_tokens` and stopped.
    const source = read('plugins/provider-openai-compat/src/stream.ts')

    expect(source).toContain('prompt_tokens_details')
    expect(source).toContain('cached_tokens')
  })

  test('gemini counts it, and takes it off the prompt total', () => {
    // Its prompt count includes the cached part, unlike Anthropic's, so
    // counting both charges for the same tokens twice.
    const source = read('plugins/provider-gemini/src/stream.ts')

    expect(source).toContain('cachedContentTokenCount')
  })
})
