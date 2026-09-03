import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createHost } from './host.ts'
import { reloadPlugins } from './reload.ts'

let cwd: string

const pluginDir = () => join(cwd, '.aidcrew', 'plugins', 'live')

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-reload-')))
  mkdirSync(pluginDir(), { recursive: true })
})

afterEach(() => rmSync(cwd, { recursive: true, force: true }))

function write(source: string): void {
  writeFileSync(join(pluginDir(), 'index.ts'), source)
}

const toolNamed = (name: string) => `import { definePlugin, defineTool } from '@aidcrew/plugin-sdk'
import { z } from 'zod'
export default definePlugin({
  name: 'live',
  tools: [defineTool({
    name: '${name}',
    description: 'A tool that appeared without a restart.',
    schema: z.object({}),
    run: async () => ({ content: '${name}' }),
  })],
})`

describe('reloading plugins without restarting', () => {
  test('a tool added while running is there afterwards', async () => {
    write(toolNamed('before'))
    const host = await createHost({ cwd, home: cwd, allowPlugin: () => true })
    expect(host.registry.tools().map((t) => t.name)).toContain('before')

    write(toolNamed('after'))
    const result = await reloadPlugins(host, { cwd, home: cwd, allowPlugin: () => true })

    expect(host.registry.tools().map((t) => t.name)).toContain('after')
    expect(host.registry.tools().map((t) => t.name)).not.toContain('before')
    if (result.failures.length > 0) console.log(JSON.stringify(result.failures, null, 1))
    expect(result.failures).toEqual([])
  })

  test('the bundled tools survive a reload', async () => {
    // Rebuilding the registry from the user's directories alone would take
    // away read, write, edit and bash — every tool the agents actually use.
    const host = await createHost({ cwd, home: cwd, allowPlugin: () => true })
    const before = host.registry.tools().length

    await reloadPlugins(host, { cwd, home: cwd, allowPlugin: () => true })

    expect(host.registry.tools().length).toBe(before)
    expect(host.registry.tools().map((t) => t.name)).toContain('read')
  })

  test('a plugin broken by the edit is reported and the old one is gone', async () => {
    write(toolNamed('fine'))
    const host = await createHost({ cwd, home: cwd, allowPlugin: () => true })

    write('this is not valid typescript !!!')
    const result = await reloadPlugins(host, { cwd, home: cwd, allowPlugin: () => true })

    expect(result.failures[0]?.reason).toContain('Expected')
    // Not left behind: a tool whose source no longer compiles is a tool that
    // would run the version you have stopped believing in.
    expect(host.registry.tools().map((t) => t.name)).not.toContain('fine')
  })
})

describe('a plugin that arrived with the repository', () => {
  test('does not run until somebody has said it may', async () => {
    // `git clone && cd && aidcrew` used to execute a stranger's TypeScript in
    // this process, with the filesystem, the network and the API keys — while
    // the same host refused to start a declared MCP server, which is a
    // separate program and strictly less dangerous, until asked.
    writeFileSync(
      join(pluginDir(), 'index.ts'),
      `await Bun.write('${join(cwd, 'RAN')}', 'yes')\nexport default { name: 'live' }`,
    )

    const host = await createHost({ cwd, home: join(cwd, 'elsewhere') })

    expect(existsSync(join(cwd, 'RAN'))).toBe(false)
    expect(host.refused.map((one) => one.name)).toEqual(['live'])
  })

  test('runs once it is allowed', async () => {
    write(toolNamed('allowed'))

    const host = await createHost({
      cwd,
      home: join(cwd, 'elsewhere'),
      allowPlugin: () => true,
    })

    expect(host.registry.tools().map((t) => t.name)).toContain('allowed')
    expect(host.refused).toEqual([])
  })

  test("the user's own plugin directory is not asked about", async () => {
    // It is theirs. They decided when they put the file there.
    const home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-home-')))
    try {
      mkdirSync(join(home, '.aidcrew', 'plugins', 'mine'), { recursive: true })
      writeFileSync(join(home, '.aidcrew', 'plugins', 'mine', 'index.ts'), toolNamed('mine'))

      const host = await createHost({ cwd: join(cwd, 'no-project-here'), home })

      expect(host.registry.tools().map((t) => t.name)).toContain('mine')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('the settings a caller hands createHost', () => {
  test("reach the setup of the plugin they are named for, and nobody else's", async () => {
    // This is the forwarding and nothing more: `createHost` reads no workspace
    // config, so the settings arrive because the caller passed them. Whether
    // the caller on the headless path passes them is a separate claim, and it
    // is proved through `main` itself in main.e2e.test.ts — a test that stops
    // here would keep passing with that wiring taken back out.
    writeFileSync(
      join(pluginDir(), 'index.ts'),
      `export default {
         name: 'live',
         setup: (host) => ({ tools: [{
           name: 'team',
           description: 'Says which team it was configured for.',
           inputSchema: { type: 'object' },
           execute: async () => ({ content: String(host.config?.team) }),
         }] }),
       }`,
    )

    const asked: string[] = []
    const host = await createHost({
      cwd,
      home: join(cwd, 'elsewhere'),
      allowPlugin: () => true,
      setup: {
        configFor: (name) => {
          asked.push(name)
          return name === 'live' ? { team: 'core' } : {}
        },
      },
    })

    const said = await host.registry
      .tool('team')
      ?.execute({}, { cwd, agentId: 'a', signal: new AbortController().signal })
    expect(said?.content).toBe('core')
    // Asked for by name, so no plugin is ever handed a table it did not put
    // there — one reading another's settings is one reading another's tokens.
    expect(asked).toEqual(['live'])
  })
})
