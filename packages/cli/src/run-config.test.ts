import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigUsageError, runConfig } from './run-config.ts'
import type { SettingsStore } from './store.ts'
import { openStore } from './store.ts'

let home: string
let store: SettingsStore

function io(secret = 'typed-key') {
  let out = ''
  let err = ''
  const prompts: string[] = []
  return {
    io: {
      write: (text: string) => {
        out += text
      },
      writeError: (text: string) => {
        err += text
      },
      readSecret: async (prompt: string) => {
        prompts.push(prompt)
        return secret
      },
    },
    get out() {
      return out
    },
    get err() {
      return err
    },
    prompts,
  }
}

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-cfg-')))
  store = openStore(home)
})

afterEach(() => {
  store.close()
  rmSync(home, { recursive: true, force: true })
})

describe('showing what is configured', () => {
  test('says where the settings live', async () => {
    const sink = io()

    await runConfig([], store, sink.io)

    expect(sink.out).toContain(store.path)
  })

  test('suggests what to do when nothing is saved', async () => {
    const sink = io()

    await runConfig([], store, sink.io)

    expect(sink.out).toMatch(/no keys saved/)
    expect(sink.out).toMatch(/set-key/)
  })

  test('lists saved keys without ever printing one', async () => {
    store.setCredential('provider:anthropic', { apiKey: 'sk-ant-supersecret' })
    const sink = io()

    await runConfig([], store, sink.io)

    expect(sink.out).toContain('provider:anthropic')
    expect(sink.out).not.toContain('supersecret')
  })

  test('lists plain settings too', async () => {
    store.set('default.model', 'claude-opus-5')
    const sink = io()

    await runConfig([], store, sink.io)

    expect(sink.out).toContain('claude-opus-5')
  })
})

describe('saving a key', () => {
  test('asks for the key and saves it', async () => {
    const sink = io('the-key')

    await runConfig(['set-key', 'provider:zen'], store, sink.io)

    expect(store.getCredential('provider:zen')?.apiKey).toBe('the-key')
    expect(sink.prompts[0]).toMatch(/provider:zen/)
  })

  test('refuses a key passed as an argument', async () => {
    // On the command line it lands in shell history and in the process list,
    // where anyone on the machine can read it.
    const sink = io()

    expect(runConfig(['set-key', 'provider:zen', 'sk-leaked'], store, sink.io)).rejects.toThrow(
      /shell history/,
    )
    expect(store.getCredential('provider:zen')).toBeUndefined()
  })

  test('saves a key for a single agent, for its own plan', async () => {
    const sink = io('max-plan-key')

    await runConfig(['set-key', 'agent:architect'], store, sink.io)

    expect(store.getCredential('agent:architect')?.apiKey).toBe('max-plan-key')
  })

  test('rejects a scope that is neither a provider nor an agent', async () => {
    expect(runConfig(['set-key', 'anthropic'], store, io().io)).rejects.toThrow(/not a scope/)
  })

  test('saves nothing when the user types nothing', async () => {
    expect(runConfig(['set-key', 'provider:zen'], store, io('  ').io)).rejects.toThrow(
      /nothing saved/,
    )
    expect(store.getCredential('provider:zen')).toBeUndefined()
  })
})

describe('forgetting and setting', () => {
  test('forgets a key', async () => {
    store.setCredential('provider:zen', { apiKey: 'k' })

    await runConfig(['unset-key', 'provider:zen'], store, io().io)

    expect(store.getCredential('provider:zen')).toBeUndefined()
  })

  test('saves a plain setting', async () => {
    await runConfig(['set', 'default.model', 'deepseek-v4'], store, io().io)

    expect(store.get('default.model')).toBe('deepseek-v4')
  })

  test('needs both a key and a value', async () => {
    expect(runConfig(['set', 'default.model'], store, io().io)).rejects.toThrow(ConfigUsageError)
  })

  test('forgets a setting', async () => {
    store.set('a', 'b')

    await runConfig(['unset', 'a'], store, io().io)

    expect(store.get('a')).toBeUndefined()
  })
})

describe('an unknown action', () => {
  test('shows what the command can do', async () => {
    expect(runConfig(['frobnicate'], store, io().io)).rejects.toThrow(/set-key/)
  })
})
