import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { SettingsStore } from './store.ts'
import { openStore } from './store.ts'

let home: string
let store: SettingsStore

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-store-')))
  store = openStore(home)
})

afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

describe('the store file', () => {
  test('lives under the user directory, never in a project', () => {
    expect(store.path).toBe(join(home, '.aidcrew', 'aidcrew.db'))
    expect(existsSync(store.path)).toBe(true)
  })

  test('is readable only by its owner', () => {
    // It records what someone works on and which services they use.
    expect(statSync(store.path).mode & 0o777).toBe(0o600)
  })

  test('so is the directory it is opened in', () => {
    // The file was locked and the directory around it was not, so its name,
    // its size and when it was last touched were readable by anyone on the
    // machine. The session record beside it already asked for this and said
    // why; whichever of the two ran first decided, which is not a decision.
    expect(statSync(join(home, '.aidcrew')).mode & 0o777).toBe(0o700)
  })

  test('reopens without losing anything', () => {
    store.set('default.model', 'a-model')
    store.close()

    const reopened = openStore(home)
    expect(reopened.get('default.model')).toBe('a-model')
    reopened.close()
    store = openStore(home)
  })
})

describe('what it knows about secrets', () => {
  test('stores and returns a key', () => {
    store.setCredential('provider:anthropic', { apiKey: 'sk-ant-123' })

    expect(store.getCredential('provider:anthropic')?.apiKey).toBe('sk-ant-123')
  })

  test('keeps a separate key for one agent, for a different plan', () => {
    store.setCredential('provider:anthropic', { apiKey: 'shared' })
    store.setCredential('agent:architect', { apiKey: 'the-max-plan' })

    expect(store.getCredential('agent:architect')?.apiKey).toBe('the-max-plan')
    expect(store.getCredential('provider:anthropic')?.apiKey).toBe('shared')
  })

  test('never returns a key in a listing', () => {
    // A listing is for showing on screen; a key there ends up in a screenshot.
    store.setCredential('provider:anthropic', { apiKey: 'sk-ant-supersecret-value' })

    expect(JSON.stringify(store.knownSecrets())).not.toContain('supersecret')
    expect(store.knownSecrets()[0]?.hint).toBe('••••alue')
  })

  test('shows nothing of a key too short to hide four characters of', () => {
    store.setCredential('provider:a', { apiKey: 'abcd' })

    expect(store.knownSecrets()[0]?.hint).not.toContain('abcd')
  })

  test('replaces a key rather than adding a second', () => {
    store.setCredential('provider:zen', { apiKey: 'old' })
    store.setCredential('provider:zen', { apiKey: 'new' })

    expect(store.getCredential('provider:zen')?.apiKey).toBe('new')
    expect(store.knownSecrets()).toHaveLength(1)
  })

  test('refuses an empty key instead of storing one that cannot work', () => {
    expect(() => store.setCredential('provider:zen', { apiKey: '  ' })).toThrow(/empty/i)
  })

  test('forgets a key', () => {
    store.setCredential('provider:zen', { apiKey: 'k' })

    store.forgetSecret('provider:zen')

    expect(store.getCredential('provider:zen')).toBeUndefined()
  })

  test('lists scopes sorted, so a settings screen is stable', () => {
    store.setCredential('provider:zen', { apiKey: 'k1' })
    store.setCredential('agent:coder', { apiKey: 'k2' })

    expect(store.knownSecrets().map((s) => s.scope)).toEqual(['agent:coder', 'provider:zen'])
  })
})

describe('workspaces', () => {
  test('remembers a project by its path', () => {
    store.rememberWorkspace('/repos/api')

    expect(store.workspaces()[0]).toMatchObject({ path: '/repos/api', name: 'api' })
  })

  test('takes a name when one is given', () => {
    store.rememberWorkspace('/repos/api', 'Inventory API')

    expect(store.workspaces()[0]?.name).toBe('Inventory API')
  })

  test('lists the most recently opened first, which is what a switcher wants', async () => {
    store.rememberWorkspace('/repos/old')
    await Bun.sleep(2)
    store.rememberWorkspace('/repos/new')

    expect(store.workspaces().map((w) => w.path)).toEqual(['/repos/new', '/repos/old'])
  })

  test('moves a project to the front when reopened', async () => {
    store.rememberWorkspace('/repos/a')
    await Bun.sleep(2)
    store.rememberWorkspace('/repos/b')
    await Bun.sleep(2)
    store.rememberWorkspace('/repos/a')

    expect(store.workspaces()[0]?.path).toBe('/repos/a')
  })

  test('does not list the same project twice', () => {
    store.rememberWorkspace('/repos/a')
    store.rememberWorkspace('/repos/a')

    expect(store.workspaces()).toHaveLength(1)
  })

  test('forgets a project', () => {
    store.rememberWorkspace('/repos/a')

    store.forgetWorkspace('/repos/a')

    expect(store.workspaces()).toEqual([])
  })
})

describe('settings', () => {
  test('stores and returns a setting', () => {
    store.set('default.model', 'claude-opus-5')

    expect(store.get('default.model')).toBe('claude-opus-5')
  })

  test('returns nothing for a setting never written', () => {
    expect(store.get('nope')).toBeUndefined()
  })

  test('overwrites a setting', () => {
    store.set('default.provider', 'zen')
    store.set('default.provider', 'anthropic')

    expect(store.get('default.provider')).toBe('anthropic')
  })

  test('lists settings sorted', () => {
    store.set('default.provider', 'zen')
    store.set('default.model', 'free')

    expect(store.list()).toEqual([
      { key: 'default.model', value: 'free' },
      { key: 'default.provider', value: 'zen' },
    ])
  })

  test('forgets a setting', () => {
    store.set('a', 'b')

    store.unset('a')

    expect(store.get('a')).toBeUndefined()
  })
})
