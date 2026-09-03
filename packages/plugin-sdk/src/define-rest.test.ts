import { describe, expect, test } from 'bun:test'
import { defineHooks, defineLoader, definePrices, defineUi } from './index.ts'

/**
 * The four capabilities that had no helper.
 *
 * `tools` and `providers` were declared through defineTool/defineProvider,
 * which check their shape and explain themselves. The other four were plain
 * object literals: a typo in one of them produced silence — a hook that never
 * ran, a slot that never drew — and silence is the most expensive kind of bug
 * for somebody learning a contract.
 */
describe('hooks', () => {
  test('a misspelled hook is refused, naming the one it nearly is', () => {
    // The worst of them: `preToolcall` is not `preToolCall`, nothing runs,
    // and no error is ever produced anywhere.
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: the point is a wrong shape
      defineHooks({ preToolcall: async () => undefined } as any),
    ).toThrow(/preToolcall.*preToolCall/)
  })

  test('a hook that is not a function is refused', () => {
    // biome-ignore lint/suspicious/noExplicitAny: the point is a wrong shape
    expect(() => defineHooks({ preTurn: 'yes' } as any)).toThrow(/preTurn/)
  })

  test('the real names pass through unchanged', () => {
    const hooks = defineHooks({ preTurn: async () => undefined })
    expect(typeof hooks.preTurn).toBe('function')
  })
})

describe('ui', () => {
  test('a slot that does not exist is refused, and lists the ones that do', () => {
    expect(() =>
      // biome-ignore lint/suspicious/noExplicitAny: the point is a name that is not a slot
      defineUi({ slots: ['traybar'] as any, render: () => undefined }),
    ).toThrow(/traybar.*tray/)
  })

  test('what it returns is checked, so a bad segment is caught where it is written', () => {
    const ui = defineUi({ render: () => [{ text: 'ok', color: '#fff' }] })
    expect(ui.render({ slot: 'tray', agents: [], target: '', theme: {}, cwd: '' })).toEqual([
      { text: 'ok', color: '#fff' },
    ])
  })

  test('a render that throws costs its own slot and nothing else', () => {
    const ui = defineUi({
      render: () => {
        throw new Error('my own fault')
      },
    })
    expect(ui.render({ slot: 'tray', agents: [], target: '', theme: {}, cwd: '' })).toBeUndefined()
  })

  test('a slot it did not ask for is not drawn', () => {
    const ui = defineUi({ slots: ['tray'], render: () => [{ text: 'x' }] })
    expect(ui.render({ slot: 'agent', agents: [], target: '', theme: {}, cwd: '' })).toBeUndefined()
  })
})

describe('loaders and prices', () => {
  test('a loader that reads nothing is refused', () => {
    // A loader with no load* function is a loader that will never be asked
    // for anything: it is not a mistake the filesystem can reveal.
    expect(() => defineLoader({ name: 'yaml-agents' })).toThrow(/yaml-agents/)
  })

  test('a loader with one reader is fine', () => {
    const loader = defineLoader({ name: 'yaml-agents', loadAgents: async () => [] })
    expect(typeof loader.loadAgents).toBe('function')
  })

  test('a price source without covers is refused', () => {
    // biome-ignore lint/suspicious/noExplicitAny: the point is a wrong shape
    expect(() => definePrices({ id: 'mine', load: async () => ({}) } as any)).toThrow(/covers/)
  })
})
