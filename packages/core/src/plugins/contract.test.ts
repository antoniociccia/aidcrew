import { describe, expect, test } from 'bun:test'
import { CONTRACT, OLDEST_CONTRACT, validatePlugin, warningsFor } from './contract.ts'

const ok = { name: 'fine' }

describe('what a plugin is checked for', () => {
  test('the five sibling arrays make the one object easy to get wrong', () => {
    // tools, providers, prices and loaders are all arrays. hooks is not, and
    // `hooks: [myHooks]` is the natural mistake — it loads clean, registers,
    // shows up in the settings screen, and never runs, because the registry
    // reads `plugin.hooks?.preToolCall` off an array and finds undefined.
    // A permission guard that is installed, listed and absent is the worst
    // thing this contract can produce.
    expect(validatePlugin({ name: 'x', hooks: [{}] })).toMatch(/hooks.*object.*array/i)
  })

  test('a misspelled capability is a warning, not a refusal', () => {
    // `tool:` for `tools:` is one letter and complete silence. Worth saying —
    // and not worth refusing the plugin over, because somebody may be
    // carrying metadata of their own and it is their object.
    expect(validatePlugin({ name: 'x', tool: [] })).toBeUndefined()
    expect(warningsFor({ name: 'x', tool: [] })[0]).toMatch(/"tool".*"tools"/)
  })

  test('a key that is nobody near a capability just says nothing reads it', () => {
    expect(warningsFor({ name: 'x', author: 'me' })[0]).toMatch(/nothing reads "author"/)
  })

  test('a plugin with only real keys has nothing to warn about', () => {
    expect(warningsFor({ name: 'x', version: '1', tools: [] })).toEqual([])
  })

  test('every capability that should be a list is checked', () => {
    for (const key of ['tools', 'providers', 'prices', 'loaders']) {
      expect(validatePlugin({ name: 'x', [key]: {} })).toContain(key)
    }
  })

  test('ui must be an object with a render', () => {
    expect(validatePlugin({ name: 'x', ui: {} })).toMatch(/render/)
    expect(validatePlugin({ name: 'x', ui: { render: () => undefined } })).toBeUndefined()
  })

  test('a tool without a name or an execute is caught here, not at call time', () => {
    expect(validatePlugin({ name: 'x', tools: [{ description: 'd' }] })).toMatch(/name/)
    expect(validatePlugin({ name: 'x', tools: [{ name: 't', description: 'd' }] })).toMatch(
      /execute/,
    )
  })

  test('a provider without a create is caught', () => {
    expect(validatePlugin({ name: 'x', providers: [{ id: 'p' }] })).toMatch(/create/)
  })

  test('what was already checked is still checked', () => {
    expect(validatePlugin(undefined)).toMatch(/no default export/)
    expect(validatePlugin('a string')).toMatch(/string/)
    expect(validatePlugin({})).toMatch(/name/)
  })

  test('a good plugin passes', () => {
    expect(validatePlugin(ok)).toBeUndefined()
    expect(
      validatePlugin({
        name: 'full',
        tools: [{ name: 't', description: 'd', inputSchema: {}, execute: async () => ({}) }],
        hooks: { preTurn: async () => undefined },
        ui: { render: () => undefined },
      }),
    ).toBeUndefined()
  })
})

describe('the contract a plugin was written against', () => {
  test('one from the future is refused, naming both numbers', () => {
    // Better than half-working: a plugin built against a contract this host
    // does not have will fail at some later, more confusing moment.
    expect(validatePlugin({ name: 'ahead', contract: CONTRACT + 1 })).toMatch(
      new RegExp(`contract ${CONTRACT + 1}.*${CONTRACT}`),
    )
  })

  test('one too old to support is refused with what to do about it', () => {
    expect(validatePlugin({ name: 'ancient', contract: OLDEST_CONTRACT - 1 })).toMatch(
      /upgrade|update|rebuild/i,
    )
  })

  test('one within the supported range is fine', () => {
    expect(validatePlugin({ name: 'current', contract: CONTRACT })).toBeUndefined()
    expect(validatePlugin({ name: 'older', contract: OLDEST_CONTRACT })).toBeUndefined()
  })

  test('a plugin that never says is assumed to be the oldest supported', () => {
    // A hand-written literal is legal, and refusing one for not carrying a
    // number the SDK stamps automatically would punish the wrong person.
    expect(validatePlugin({ name: 'quiet' })).toBeUndefined()
    expect(warningsFor({ name: 'quiet' })).toEqual([])
  })

  test('a contract that is not a number is refused', () => {
    expect(validatePlugin({ name: 'odd', contract: 'one' })).toMatch(/contract/)
  })
})

describe('a plugin that builds itself', () => {
  test('is not told that nothing reads the key carrying its whole capability', () => {
    // `setup` shipped one commit before this list learned about it, so every
    // plugin using the newest part of the contract was told, on stderr at
    // every headless start and in a note in every session, that the one key
    // holding its tools is ignored. Nothing was ignored; the warning was.
    expect(warningsFor({ name: 'x', setup: () => ({}) })).toEqual([])
  })

  test('one whose setup is not callable is refused rather than crashed into', () => {
    // The alternative is a TypeError from inside the loader with the plugin's
    // name nowhere near it.
    expect(validatePlugin({ name: 'x', setup: 'later' })).toMatch(/setup.*function/i)
  })
})
