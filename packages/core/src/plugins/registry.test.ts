import { describe, expect, test } from 'bun:test'
import type { Tool } from '../loop.ts'
import { DuplicateCapabilityError, PluginRegistry } from './registry.ts'
import type { Plugin } from './types.ts'

function tool(name: string): Tool {
  return {
    name,
    description: `the ${name} tool`,
    inputSchema: { type: 'object' },
    execute: async () => ({ content: 'ok' }),
  }
}

function provider(id: string) {
  return {
    id,
    create: () => ({ id, send: async function* () {} }),
  }
}

describe('PluginRegistry', () => {
  test('collects the tools of every registered plugin', () => {
    const registry = new PluginRegistry()

    registry.register({ name: 'fs', tools: [tool('read'), tool('write')] })
    registry.register({ name: 'shell', tools: [tool('bash')] })

    expect(
      registry
        .tools()
        .map((t) => t.name)
        .sort(),
    ).toEqual(['bash', 'read', 'write'])
  })

  test('finds a tool by name', () => {
    const registry = new PluginRegistry()
    registry.register({ name: 'fs', tools: [tool('read')] })

    expect(registry.tool('read')?.description).toBe('the read tool')
    expect(registry.tool('missing')).toBeUndefined()
  })

  test('finds a provider by id', () => {
    const registry = new PluginRegistry()
    registry.register({ name: 'openai', providers: [provider('zen')] })

    expect(registry.provider('zen')?.id).toBe('zen')
  })

  test('names both plugins when two claim the same tool', () => {
    // Silently keeping one would make the agent's behaviour depend on load
    // order, which is the hardest kind of bug to see.
    const registry = new PluginRegistry()
    registry.register({ name: 'fs', tools: [tool('read')] })

    expect(() => registry.register({ name: 'other-fs', tools: [tool('read')] })).toThrow(
      DuplicateCapabilityError,
    )
    expect(() => registry.register({ name: 'other-fs', tools: [tool('read')] })).toThrow(
      /fs.*other-fs|other-fs.*fs/,
    )
  })

  test('rejects two providers with the same id', () => {
    const registry = new PluginRegistry()
    registry.register({ name: 'a', providers: [provider('zen')] })

    expect(() => registry.register({ name: 'b', providers: [provider('zen')] })).toThrow(
      DuplicateCapabilityError,
    )
  })

  test('rejects two plugins with the same name', () => {
    const registry = new PluginRegistry()
    registry.register({ name: 'fs' })

    expect(() => registry.register({ name: 'fs' })).toThrow(DuplicateCapabilityError)
  })

  test('leaves the registry unchanged when a registration fails', () => {
    const registry = new PluginRegistry()
    registry.register({ name: 'fs', tools: [tool('read')] })

    // The second tool of the rejected plugin must not survive the failure.
    expect(() =>
      registry.register({ name: 'bad', tools: [tool('read'), tool('brand-new')] }),
    ).toThrow(DuplicateCapabilityError)

    expect(registry.tool('brand-new')).toBeUndefined()
    expect(registry.plugins().map((p) => p.name)).toEqual(['fs'])
  })

  test('accepts a plugin that declares no capabilities', () => {
    const registry = new PluginRegistry()

    registry.register({ name: 'empty' })

    expect(registry.plugins()).toHaveLength(1)
    expect(registry.tools()).toHaveLength(0)
  })

  test('accepts one plugin that provides both tools and providers', () => {
    const registry = new PluginRegistry()

    registry.register({ name: 'both', tools: [tool('read')], providers: [provider('zen')] })

    expect(registry.tool('read')).toBeDefined()
    expect(registry.provider('zen')).toBeDefined()
  })

  test('reports which plugin a tool came from', () => {
    const registry = new PluginRegistry()
    registry.register({ name: 'fs', tools: [tool('read')] })

    expect(registry.sourceOfTool('read')).toBe('fs')
  })

  test('keeps hooks from every plugin, since they compose rather than collide', () => {
    const calls: string[] = []
    const registry = new PluginRegistry()

    registry.register({
      name: 'a',
      hooks: {
        preToolCall: async () => {
          calls.push('a')
        },
      },
    })
    registry.register({
      name: 'b',
      hooks: {
        preToolCall: async () => {
          calls.push('b')
        },
      },
    })

    expect(registry.hooks('preToolCall')).toHaveLength(2)
  })
})

describe('registry as a plugin list', () => {
  test('preserves registration order, which decides hook order', () => {
    const registry = new PluginRegistry()
    registry.register({ name: 'first' })
    registry.register({ name: 'second' })

    expect(registry.plugins().map((p: Plugin) => p.name)).toEqual(['first', 'second'])
  })
})

describe('what a plugin adds to the interface', () => {
  const context = {
    slot: 'tray' as const,
    agents: [],
    target: 'coder',
    theme: { accent: '#7dd3fc' },
    cwd: '/repo',
  }

  test('collects segments from every plugin that has any', () => {
    const registry = new PluginRegistry()
    registry.register({
      name: 'clock',
      ui: { render: () => [{ text: '12:04' }] },
    })
    registry.register({
      name: 'branch',
      ui: { render: () => [{ text: 'main', color: '#fff' }] },
    })

    expect(registry.ui(context)).toEqual([{ text: '12:04' }, { text: 'main', color: '#fff' }])
  })

  test('a plugin that returns nothing simply adds nothing', () => {
    const registry = new PluginRegistry()
    registry.register({ name: 'quiet', ui: { render: () => undefined } })

    expect(registry.ui(context)).toEqual([])
  })

  test('one that throws costs its own segments and nothing else', () => {
    // A screen that goes blank over somebody's typo in a plugin is worse than
    // a screen missing one line of it.
    const failures: string[] = []
    const registry = new PluginRegistry()
    registry.register({
      name: 'broken',
      ui: {
        render: () => {
          throw new Error('nope')
        },
      },
    })
    registry.register({ name: 'fine', ui: { render: () => [{ text: 'still here' }] } })

    expect(registry.ui(context, (plugin) => failures.push(plugin))).toEqual([
      { text: 'still here' },
    ])
    // Named, because a plugin that quietly draws nothing is one nobody can
    // debug.
    expect(failures).toEqual(['broken'])
  })

  test('a plugin sees which slot it is being asked about', () => {
    const seen: string[] = []
    const registry = new PluginRegistry()
    registry.register({
      name: 'watcher',
      ui: {
        render: (given) => {
          seen.push(given.slot)
          return undefined
        },
      },
    })

    registry.ui(context)
    registry.ui({ ...context, slot: 'agent' })

    expect(seen).toEqual(['tray', 'agent'])
  })
})

describe('replacing everything a registry holds', () => {
  test('what it offers afterwards is what the other one had', () => {
    // The host hands its registry out — the agent loop, the interface and the
    // MCP bridge all keep the same object — so a reload cannot swap it for a
    // new one without leaving every holder looking at the old contents.
    const live = new PluginRegistry()
    live.register({ name: 'old', tools: [tool('gone')] })

    const rebuilt = new PluginRegistry()
    rebuilt.register({ name: 'new', tools: [tool('fresh')] })

    live.replaceWith(rebuilt)

    expect(live.tools().map((t) => t.name)).toEqual(['fresh'])
    expect(live.tool('gone')).toBeUndefined()
  })

  test('a name freed by the replacement can be claimed again', () => {
    // Otherwise the second reload refuses the plugin the first one accepted.
    const live = new PluginRegistry()
    live.register({ name: 'a', tools: [tool('shared')] })

    const rebuilt = new PluginRegistry()
    rebuilt.register({ name: 'b', tools: [tool('shared')] })

    expect(() => live.replaceWith(rebuilt)).not.toThrow()
    expect(live.tools()).toHaveLength(1)
  })
})

describe('what a conflict says', () => {
  test('two plugins with the same name are told apart by where they came from', () => {
    // "plugin \"live\" is provided by both \"live\" and \"live\"" is a true
    // sentence that helps nobody. The names are the same — that is the
    // problem — so the message has to carry something else.
    const registry = new PluginRegistry()
    registry.register({ name: 'live', tools: [tool('a')] })

    expect(() => registry.register({ name: 'live', tools: [tool('b')] })).toThrow(
      /"live" is already registered/,
    )
  })

  test('two plugins claiming one tool name each name themselves', () => {
    const registry = new PluginRegistry()
    registry.register({ name: 'first', tools: [tool('shared')] })

    expect(() => registry.register({ name: 'second', tools: [tool('shared')] })).toThrow(
      /tool "shared".*"first".*"second"/,
    )
  })
})

describe('knowing which plugin a hook belongs to', () => {
  test('installedHooks pairs each set with its plugin', () => {
    // So "a hook threw" can say whose. With ten plugins installed, naming the
    // hook narrows it to ten possibilities, which is no narrowing at all.
    const registry = new PluginRegistry()
    registry.register({ name: 'quiet', tools: [tool('a')] })
    registry.register({ name: 'guard', hooks: { preToolCall: async () => undefined } })

    expect(registry.installedHooks().map((one) => one.plugin)).toEqual(['guard'])
  })

  test('the order is the order they were registered', () => {
    const registry = new PluginRegistry()
    registry.register({ name: 'first', hooks: { preTurn: async () => undefined } })
    registry.register({ name: 'second', hooks: { preTurn: async () => undefined } })

    expect(registry.installedHooks().map((one) => one.plugin)).toEqual(['first', 'second'])
  })
})

describe('a price source that misbehaves', () => {
  test('one that rejects does not take the others with it', async () => {
    // The price lookup awaited every source with no try/catch, so one
    // rejecting source was an unhandled rejection AND lost the prices of
    // every other source and provider. A price list is a convenience; it can
    // never be a precondition.
    const registry = new PluginRegistry()
    registry.register({
      name: 'broken',
      prices: [
        {
          id: 'broken',
          covers: () => true,
          load: async () => {
            throw new Error('no')
          },
        },
      ],
    })
    registry.register({
      name: 'working',
      prices: [
        {
          id: 'working',
          covers: () => true,
          load: async () => ({ 'a-model': { input: 1, output: 2, from: 'working' } }),
        },
      ],
    })

    const results = await Promise.all(registry.prices().map((source) => source.load('any', {})))

    expect(results[0]).toEqual({})
    expect(results[1]?.['a-model']?.input).toBe(1)
  })

  test('one that returns nonsense is treated as knowing nothing', async () => {
    const registry = new PluginRegistry()
    registry.register({
      name: 'odd',
      // biome-ignore lint/suspicious/noExplicitAny: the point is a wrong return
      prices: [{ id: 'odd', covers: () => true, load: (async () => 'not a table') as any }],
    })

    expect(await registry.prices()[0]?.load('any', {})).toEqual({})
  })
})

/**
 * Taking a plugin back out.
 *
 * Some plugins belong to a session rather than to the program: the interface
 * builds a compactor and an approval gate around the team it is starting, and
 * both are made from that team's agents and models. Opening a second project
 * builds them again — and the registry, quite correctly, refused the second
 * one and said two directories must hold a plugin of that name.
 *
 * Nothing did. The same session was registering the same name twice, and the
 * message sent whoever read it hunting a duplicate directory that does not
 * exist. What was missing was a way to say the first one is finished with.
 */
describe('a plugin the session is finished with', () => {
  const compactor = (): Plugin => ({
    name: 'hooks-compact',
    version: '1.0.0',
    hooks: { preTurn: async () => undefined },
  })

  test('can be taken out, so the next session can put its own in', () => {
    const registry = new PluginRegistry()
    registry.register(compactor())

    expect(registry.forget('hooks-compact')).toBe(true)
    expect(() => registry.register(compactor())).not.toThrow()
  })

  test('takes its tools and providers with it', () => {
    // Half-forgotten is worse than not forgotten: a tool still answering for
    // a plugin that is gone belongs to nobody, and the next plugin of that
    // name collides with a ghost.
    const registry = new PluginRegistry()
    registry.register({
      name: 'session',
      version: '1.0.0',
      tools: [
        {
          name: 'ask',
          description: 'asks',
          inputSchema: {},
          execute: async () => ({ content: '' }),
        },
      ],
      providers: [
        { id: 'made-up', create: () => ({ id: 'made-up', send: async function* () {} }) },
      ],
    })

    registry.forget('session')

    expect(registry.tool('ask')).toBeUndefined()
    expect(registry.provider('made-up')).toBeUndefined()
    expect(registry.plugins().map((one) => one.name)).not.toContain('session')
  })

  test('says plainly when there was nothing of that name', () => {
    expect(new PluginRegistry().forget('never-there')).toBe(false)
  })

  test('leaves everybody else exactly as they were', () => {
    const registry = new PluginRegistry()
    registry.register({
      name: 'keeper',
      version: '1.0.0',
      tools: [
        {
          name: 'read',
          description: 'reads',
          inputSchema: {},
          execute: async () => ({ content: '' }),
        },
      ],
    })
    registry.register(compactor())

    registry.forget('hooks-compact')

    expect(registry.tool('read')).toBeDefined()
    expect(registry.plugins().map((one) => one.name)).toEqual(['keeper'])
  })
})
