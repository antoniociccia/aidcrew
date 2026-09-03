import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPluginsFrom } from './loader.ts'

let root: string
let cwd: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-setup-')))
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-setup-cwd-')))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
  rmSync(cwd, { recursive: true, force: true })
})

function plugin(name: string, source: string): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, 'index.ts'), source)
}

/**
 * The four most interesting plugins that ship cannot be written by a stranger.
 *
 * hooks-guard and hooks-compact default-export a plugin with no hooks at all;
 * their real capability exists only when a file inside this repository calls
 * a `create*Plugin` factory and hands it things — a way to ask a person, the
 * workspace, its own settings — that no third party can reach. That is the
 * ceiling between a plugin you write for yourself and one strangers install.
 */
describe('a plugin that needs to be told something before it can work', () => {
  test('setup is called with where the work is', async () => {
    plugin(
      'aware',
      `export default {
         name: 'aware',
         setup: (host) => ({ tools: [{
           name: 'where',
           description: 'Says where the work is.',
           inputSchema: { type: 'object' },
           execute: async () => ({ content: host.cwd }),
         }] }),
       }`,
    )

    const result = await loadPluginsFrom([root], { setup: { cwd, home: root } })

    const tool = result.loaded[0]?.tools?.[0]
    expect(
      (await tool?.execute({}, { cwd, agentId: 'a', signal: new AbortController().signal }))
        ?.content,
    ).toBe(cwd)
  })

  test('its own settings reach it, and nothing else does', async () => {
    plugin(
      'configured',
      `export default {
         name: 'configured',
         setup: (host) => ({ tools: [{
           name: 'say',
           description: 'Says what it was configured with.',
           inputSchema: { type: 'object' },
           execute: async () => ({ content: JSON.stringify(host.config) }),
         }] }),
       }`,
    )

    const result = await loadPluginsFrom([root], {
      setup: {
        cwd,
        home: root,
        configFor: (name) => (name === 'configured' ? { greeting: 'hello' } : { secret: 'no' }),
      },
    })

    const tool = result.loaded[0]?.tools?.[0]
    const said = await tool?.execute(
      {},
      { cwd, agentId: 'a', signal: new AbortController().signal },
    )
    expect(said?.content).toBe('{"greeting":"hello"}')
  })

  test('what setup returns is merged over what the plugin declared', async () => {
    plugin(
      'both',
      `export default {
         name: 'both',
         tools: [{ name: 'static', description: 'Always there.', inputSchema: {}, execute: async () => ({ content: '' }) }],
         setup: () => ({ hooks: { preTurn: async () => undefined } }),
       }`,
    )

    const result = await loadPluginsFrom([root], { setup: { cwd, home: root } })

    expect(result.loaded[0]?.tools?.[0]?.name).toBe('static')
    expect(typeof result.loaded[0]?.hooks?.preTurn).toBe('function')
  })

  test('a setup that throws is a plugin that did not load, with the reason', async () => {
    plugin(
      'angry',
      `export default { name: 'angry', setup: () => { throw new Error('needs a token') } }`,
    )

    const result = await loadPluginsFrom([root], { setup: { cwd, home: root } })

    expect(result.loaded).toEqual([])
    expect(result.failed[0]?.reason).toContain('needs a token')
  })

  test('a setup that returns something invalid is caught by the same validator', async () => {
    plugin('wrong', `export default { name: 'wrong', setup: () => ({ hooks: [{}] }) }`)

    const result = await loadPluginsFrom([root], { setup: { cwd, home: root } })

    expect(result.loaded).toEqual([])
    expect(result.failed[0]?.reason).toMatch(/hooks.*object.*array/i)
  })

  test('an async setup is awaited', async () => {
    plugin(
      'slow',
      `export default {
         name: 'slow',
         setup: async () => {
           await new Promise((r) => setTimeout(r, 5))
           return { tools: [{ name: 'late', description: 'Arrived late.', inputSchema: {}, execute: async () => ({ content: '' }) }] }
         },
       }`,
    )

    const result = await loadPluginsFrom([root], { setup: { cwd, home: root } })

    expect(result.loaded[0]?.tools?.[0]?.name).toBe('late')
  })

  test('a plugin with no setup is untouched', async () => {
    plugin('plain', `export default { name: 'plain' }`)

    const result = await loadPluginsFrom([root], { setup: { cwd, home: root } })

    expect(result.loaded[0]?.name).toBe('plain')
  })
})

describe('who is asking, and who said it', () => {
  test('the question carries the name of the plugin putting it', async () => {
    // "May I use the token in your keychain?" is not a question anybody can
    // answer without knowing who is asking. The name was two lines from where
    // the host was built and was never passed on, so whatever drew the prompt
    // had only a sentence and no author.
    plugin(
      'asker',
      `export default {
         name: 'asker',
         setup: async (host) => { await host.ask?.({ title: 'Use your token?' }); return {} },
       }`,
    )
    const asked: { name: string; title: string }[] = []

    await loadPluginsFrom([root], {
      setup: {
        cwd,
        home: root,
        ask: async (name, question) => {
          asked.push({ name, title: question.title })
          return true
        },
      },
    })

    expect(asked).toEqual([{ name: 'asker', title: 'Use your token?' }])
  })

  test('so does what it says, so nobody has to write their own name', async () => {
    // Every plugin prefixing its own messages by hand is every plugin getting
    // it slightly differently, and one forgetting.
    plugin(
      'chatty',
      `export default { name: 'chatty', setup: (host) => { host.say?.('the token is not set'); return {} } }`,
    )
    const said: { name: string; text: string }[] = []

    await loadPluginsFrom([root], {
      setup: { cwd, home: root, say: (name, text) => said.push({ name, text }) },
    })

    expect(said).toEqual([{ name: 'chatty', text: 'the token is not set' }])
  })
})
