import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig } from './config.ts'
import type { SettingsStore } from './store.ts'
import { openStore } from './store.ts'

let home: string
let store: SettingsStore

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-conf-')))
  store = openStore(home)
})

afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

describe('loadConfig', () => {
  test('reads the model saved from the interface', () => {
    store.set('default.model', 'claude-opus-5')

    expect(loadConfig({}, store).model).toBe('claude-opus-5')
  })

  test('reads the provider saved from the interface', () => {
    store.set('default.provider', 'anthropic')
    store.set('default.model', 'm')

    expect(loadConfig({}, store).providerId).toBe('anthropic')
  })

  test('lets the environment override a saved value for one run', () => {
    store.set('default.model', 'saved')

    expect(loadConfig({ AIDCREW_MODEL: 'just-this-once' }, store).model).toBe('just-this-once')
  })

  test('defaults to the zen provider when nothing says otherwise', () => {
    store.set('default.model', 'm')

    expect(loadConfig({}, store).providerId).toBe('zen')
  })

  test('explains how to set a model rather than just refusing', () => {
    try {
      loadConfig({}, store)
      throw new Error('expected loadConfig to reject')
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError)
      expect((error as Error).message).toMatch(/aidcrew config set default\.model/)
    }
  })

  test('works from the environment alone, with no store', () => {
    expect(loadConfig({ AIDCREW_MODEL: 'm', AIDCREW_PROVIDER: 'zen' })).toEqual({
      providerId: 'zen',
      model: 'm',
    })
  })

  test('does not deal in credentials at all', () => {
    store.set('default.model', 'm')

    // Keys are resolved per agent, so a team can span providers and plans.
    expect(Object.keys(loadConfig({}, store))).toEqual(['providerId', 'model'])
  })
})
