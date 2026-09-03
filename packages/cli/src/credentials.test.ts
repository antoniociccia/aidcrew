import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { AgentDef } from '@aidcrew/core'
import { keyForAgent, keyForProvider, resolveTeamCredentials, slug } from './credentials.ts'
import type { SettingsStore } from './store.ts'
import { openStore } from './store.ts'

const agent = (id: string, extra: Partial<AgentDef> = {}): AgentDef => ({
  id,
  description: '',
  systemPrompt: '',
  ...extra,
})

function storeWith(entries: Record<string, string>): SettingsStore {
  const store = openStore(mkdtempSync(join(tmpdir(), 'aidcrew-cred-')))
  for (const [scope, apiKey] of Object.entries(entries)) store.setCredential(scope, { apiKey })
  open.push(store)
  return store
}

const open: SettingsStore[] = []
afterEach(() => {
  for (const store of open.splice(0)) store.close()
})

describe('slug', () => {
  test('spells a provider id as an environment variable', () => {
    expect(slug('openai-compat')).toBe('OPENAI_COMPAT')
  })
})

describe('from the settings alone', () => {
  test('finds a provider key entered in the interface', async () => {
    const store = storeWith({ 'provider:zen': 'from-the-settings' })

    const resolved = keyForProvider('zen', { env: {}, store })

    expect(resolved?.apiKey).toBe('from-the-settings')
    expect(resolved?.source).toMatch(/saved/)
  })

  test('gives an agent its own key, for a different plan', async () => {
    const store = storeWith({
      'provider:anthropic': 'team-key',
      'agent:architect': 'the-max-plan',
    })

    expect(keyForAgent(agent('architect'), 'anthropic', { env: {}, store })?.apiKey).toBe(
      'the-max-plan',
    )
    expect(keyForAgent(agent('coder'), 'anthropic', { env: {}, store })?.apiKey).toBe('team-key')
  })
})

describe('the environment wins over what is saved', () => {
  test('an exported key beats a saved one', async () => {
    const store = storeWith({ 'provider:zen': 'saved' })

    const resolved = keyForProvider('zen', {
      env: { AIDCREW_API_KEY_ZEN: 'exported' },
      store,
    })

    expect(resolved?.apiKey).toBe('exported')
  })

  test('the variable an agent names beats its saved key', async () => {
    const store = storeWith({ 'agent:architect': 'saved' })

    const resolved = keyForAgent(agent('architect', { apiKeyEnv: 'MY_KEY' }), 'zen', {
      env: { MY_KEY: 'exported' },
      store,
    })

    expect(resolved?.apiKey).toBe('exported')
  })

  test('falls back to the saved key when the named variable is unset', async () => {
    const store = storeWith({ 'agent:architect': 'saved' })

    const resolved = keyForAgent(agent('architect', { apiKeyEnv: 'ABSENT' }), 'zen', {
      env: {},
      store,
    })

    expect(resolved?.apiKey).toBe('saved')
  })
})

describe('precedence, most specific first', () => {
  test('agent beats provider beats shared', async () => {
    const store = storeWith({
      'agent:a': 'agent-level',
      'provider:zen': 'provider-level',
    })
    const sources = { env: { AIDCREW_API_KEY: 'shared' }, store }

    expect(keyForAgent(agent('a'), 'zen', sources)?.apiKey).toBe('agent-level')
    expect(keyForAgent(agent('b'), 'zen', sources)?.apiKey).toBe('provider-level')
    expect(keyForAgent(agent('c'), 'other', sources)?.apiKey).toBe('shared')
  })

  test('reports where a key came from', async () => {
    const resolved = keyForProvider('zen', { env: { AIDCREW_API_KEY: 'k' } })

    expect(resolved?.source).toBe('AIDCREW_API_KEY')
  })

  test('carries a base url override', async () => {
    const resolved = keyForProvider('ollama', {
      env: { AIDCREW_API_KEY: 'k', AIDCREW_BASE_URL_OLLAMA: 'http://localhost:11434/v1' },
    })

    expect(resolved?.baseUrl).toBe('http://localhost:11434/v1')
  })
})

describe('resolving a whole team at once', () => {
  test('gives each agent the key its own configuration points to', async () => {
    const store = storeWith({
      'agent:architect': 'max-plan',
      'provider:deepseek': 'deepseek-key',
    })

    const credentials = resolveTeamCredentials(
      [agent('architect', { provider: 'anthropic' }), agent('coder', { provider: 'deepseek' })],
      'zen',
      { env: {}, store },
    )

    expect(credentials.for('architect')?.apiKey).toBe('max-plan')
    expect(credentials.for('coder')?.apiKey).toBe('deepseek-key')
    expect(credentials.missing).toEqual([])
  })

  test('names every agent without a key, rather than stopping at the first', async () => {
    // Fixing them one run at a time is the kind of thing that makes people
    // give up on a tool.
    const credentials = resolveTeamCredentials(
      [agent('a', { provider: 'anthropic' }), agent('b', { provider: 'deepseek' })],
      'zen',
      { env: {} },
    )

    expect(credentials.missing).toEqual([
      { agentId: 'a', providerId: 'anthropic' },
      { agentId: 'b', providerId: 'deepseek' },
    ])
  })

  test('falls back to the session default provider', async () => {
    const store = storeWith({ 'provider:zen': 'zen-key' })

    const credentials = resolveTeamCredentials([agent('a')], 'zen', { env: {}, store })

    expect(credentials.for('a')?.apiKey).toBe('zen-key')
  })
})

describe('nothing configured', () => {
  test('reports no key rather than an empty one', async () => {
    expect(keyForProvider('zen', { env: {} })).toBeUndefined()
  })

  test('works from the environment alone, with no store', async () => {
    expect(keyForProvider('zen', { env: { AIDCREW_API_KEY: 'k' } })?.apiKey).toBe('k')
  })
})

describe('a provider that needs no key', () => {
  test('lets its agent run without one', () => {
    // A model served on this machine has nobody to show a key to. Demanding
    // one would mean inventing it to get past the check.
    const team = [{ ...agent('coder'), provider: 'local' }]

    const sources = { env: {}, store: storeWith({}) }
    const resolved = resolveTeamCredentials(team, 'local', sources, (id) => id !== 'local')

    expect(resolved.missing).toEqual([])
    expect(resolved.for('coder')?.apiKey).toBe('')
  })

  test('still stops an agent whose provider does need one', () => {
    const team = [{ ...agent('coder'), provider: 'zen' }]

    const sources = { env: {}, store: storeWith({}) }
    const resolved = resolveTeamCredentials(team, 'zen', sources, () => true)

    expect(resolved.missing).toEqual([{ agentId: 'coder', providerId: 'zen' }])
  })

  test('demands a key when nothing says otherwise', () => {
    // The default must be the safe one: a provider that forgot to declare
    // itself should be asked for a key, not waved through.
    const team = [{ ...agent('coder'), provider: 'zen' }]

    const sources = { env: {}, store: storeWith({}) }

    expect(resolveTeamCredentials(team, 'zen', sources).missing).toHaveLength(1)
  })
})

describe('a second agent of the same kind', () => {
  test('uses what the one it was copied from uses', () => {
    const team = [{ id: 'coder', description: '', systemPrompt: '', provider: 'zen' }]
    const resolved = resolveTeamCredentials(team, 'zen', {
      env: { AIDCREW_API_KEY_ZEN: 'sk-zen' },
    })

    // Spawned mid-session to take work a busy `coder` could not, so it was
    // never in the team the keys were resolved for.
    expect(resolved.for('coder-2')?.apiKey).toBe('sk-zen')
    expect(resolved.for('coder-2')?.source).toBe(resolved.for('coder')?.source)
  })

  test('an agent started on a task uses the key of the role it was made from', () => {
    // `/task feat coder` spawns `feat/coder`, which was not on the team the
    // keys were resolved for. It appeared, you told it something, and every
    // turn failed with "feat/coder needs a key" — the one feature the README
    // leads with, unusable.
    const team = [{ id: 'coder', description: '', systemPrompt: '', provider: 'zen' }]
    const resolved = resolveTeamCredentials(team, 'zen', {
      env: { AIDCREW_API_KEY_ZEN: 'sk-zen' },
    })

    expect(resolved.for('feat/coder')?.apiKey).toBe('sk-zen')
    expect(resolved.for('feat/coder-2')?.apiKey).toBe('sk-zen')
  })

  test('does not invent a key for a name that merely ends in a number', () => {
    const resolved = resolveTeamCredentials([], 'zen', { env: {} })

    expect(resolved.for('nobody-2')).toBeUndefined()
  })
})

describe('an agent that joins after the team started', () => {
  const later = agent('plugin-writer', { provider: 'zen' })

  test('has no key until it is admitted', () => {
    const resolved = resolveTeamCredentials([], 'zen', { env: { AIDCREW_API_KEY: 'k' } })
    expect(resolved.for('plugin-writer')).toBeUndefined()
  })

  test('resolves its key when admitted', () => {
    const resolved = resolveTeamCredentials([], 'zen', { env: { AIDCREW_API_KEY: 'k' } })
    expect(resolved.admit(later)).toBe(true)
    expect(resolved.for('plugin-writer')?.apiKey).toBe('k')
  })

  test('says so when there is no key for it', () => {
    const resolved = resolveTeamCredentials([], 'zen', { env: {} })
    expect(resolved.admit(later)).toBe(false)
    expect(resolved.for('plugin-writer')).toBeUndefined()
  })

  test('admits an agent whose provider needs no key', () => {
    const resolved = resolveTeamCredentials([], 'zen', { env: {} }, () => false)
    expect(resolved.admit(agent('writer', { provider: 'opencode-go' }))).toBe(true)
    expect(resolved.for('writer')?.apiKey).toBe('')
  })
})
