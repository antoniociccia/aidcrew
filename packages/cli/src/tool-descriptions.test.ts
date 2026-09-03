import { describe, expect, test } from 'bun:test'
import { createHost } from './host.ts'

/**
 * What the tools tell the model about themselves.
 *
 * A tool's description is not documentation: it is the only thing the model
 * reads before choosing, it is sent on every request of every turn, and it is
 * where the money goes. A model that does not know `wc` exists reads a file of
 * four thousand lines to count them, and a model that does not know `grep`
 * exists runs `bash cat` over a directory.
 *
 * So these are rules about the descriptions themselves, checked here rather
 * than left to whoever writes the next tool.
 */

async function tools() {
  const host = await createHost({ pluginDirs: [], mcpFiles: [] })
  return host.registry.tools()
}

describe('every tool description', () => {
  test('exists, and says more than the tool name already said', async () => {
    for (const tool of await tools()) {
      expect(tool.description.length).toBeGreaterThan(40)
    }
  })

  test('stays short enough to be sent on every request', async () => {
    // Forty words is about fifty tokens, times ten tools, times every request
    // of every turn of every agent. Anything longer belongs in a skill, which
    // is loaded when it is needed and paid for then.
    for (const tool of await tools()) {
      expect(tool.description.split(/\s+/).length).toBeLessThanOrEqual(60)
    }
  })

  test('sends the model somewhere cheaper when somewhere cheaper exists', async () => {
    // The two that matter. `bash` and `read` are the tools a model reaches for
    // by habit, and both have cheaper answers for the most common questions —
    // but only if their own description says so, because the model is choosing
    // from these descriptions and nothing else.
    const all = await tools()
    const named = (name: string) => all.find((tool) => tool.name === name)?.description ?? ''

    expect(named('bash')).toMatch(/grep/)
    expect(named('bash')).toMatch(/glob/)
    expect(named('read')).toMatch(/grep/)
    expect(named('read')).toMatch(/wc/)
  })

  test('names the tool to use instead, rather than saying "another tool"', async () => {
    // A pointer without a name is not a pointer. Every mention of an
    // alternative has to be a tool that actually exists, or the model spends a
    // turn calling something that is not there.
    const all = await tools()
    const names = new Set(all.map((tool) => tool.name))

    for (const tool of all) {
      const mentioned = tool.description.matchAll(/\buse (\w+) (?:instead|to|for)\b/gi)
      for (const [, named] of mentioned) {
        const word = (named ?? '').toLowerCase()
        // "use it to …" is the tool talking about itself, not a pointer.
        if (['it', 'this', 'them', 'these'].includes(word)) continue
        expect(names.has(word)).toBe(true)
      }
    }
  })
})
