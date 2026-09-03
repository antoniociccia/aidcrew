import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runPlugins, trustedPlugins } from './run-plugins.ts'
import type { SettingsStore } from './store.ts'
import { openStore } from './store.ts'

let cwd: string
let home: string
let store: SettingsStore
let out: string[]
let errors: string[]

const io = () => ({
  write: (text: string) => out.push(text),
  writeError: (text: string) => errors.push(text),
})

beforeEach(() => {
  cwd = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-plugincmd-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-pluginhome-')))
  store = openStore(home)
  out = []
  errors = []
})

afterEach(() => {
  store.close()
  rmSync(cwd, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

function offered(name: string): void {
  mkdirSync(join(cwd, '.aidcrew', 'plugins', name), { recursive: true })
  writeFileSync(
    join(cwd, '.aidcrew', 'plugins', name, 'index.ts'),
    `export default { name: '${name}' }`,
  )
}

/** A plugin of this project, written the way its author would write it. */
function written(name: string, source: string): string {
  const directory = join(cwd, '.aidcrew', 'plugins', name)
  mkdirSync(directory, { recursive: true })
  writeFileSync(join(directory, 'index.ts'), source)
  return directory
}

/** What this project says in `.aidcrew/config.toml`. */
function configured(toml: string): void {
  mkdirSync(join(cwd, '.aidcrew'), { recursive: true })
  writeFileSync(join(cwd, '.aidcrew', 'config.toml'), toml)
}

describe('aidcrew plugin', () => {
  test('lists what the project offers and whether it runs', async () => {
    offered('linear')

    expect(await runPlugins([], store, io(), cwd, home)).toBe(0)

    expect(out.join('')).toContain('linear')
    expect(out.join('')).toContain('not trusted')
  })

  test('trusting one makes it load', async () => {
    offered('linear')

    await runPlugins(['trust', 'linear'], store, io(), cwd, home)

    expect(trustedPlugins(store, cwd)({ name: 'linear', path: '', scope: 'project' })).toBe(true)
  })

  test('trust is per workspace, because a name is easy to reuse', async () => {
    offered('linear')
    await runPlugins(['trust', 'linear'], store, io(), cwd, home)

    const elsewhere = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-other-')))
    try {
      expect(trustedPlugins(store, elsewhere)({ name: 'linear', path: '', scope: 'project' })).toBe(
        false,
      )
    } finally {
      rmSync(elsewhere, { recursive: true, force: true })
    }
  })

  test('revoking takes it back', async () => {
    offered('linear')
    await runPlugins(['trust', 'linear'], store, io(), cwd, home)
    await runPlugins(['revoke', 'linear'], store, io(), cwd, home)

    expect(trustedPlugins(store, cwd)({ name: 'linear', path: '', scope: 'project' })).toBe(false)
  })

  test('trusting something that is not there says so rather than remembering it', async () => {
    // Otherwise a typo is stored forever and the real plugin is still refused,
    // with a list that says it is trusted.
    expect(await runPlugins(['trust', 'lienar'], store, io(), cwd, home)).toBe(1)
    expect(errors.join('')).toContain('lienar')
  })

  test('says what to type when the name is missing', async () => {
    expect(await runPlugins(['trust'], store, io(), cwd, home)).toBe(1)
    expect(errors.join('')).toContain('aidcrew plugin trust <name>')
  })

  test('a project with no plugins says so plainly', async () => {
    expect(await runPlugins([], store, io(), cwd, home)).toBe(0)
    expect(out.join('')).toContain('no plugins')
  })
})

describe('aidcrew plugin check', () => {
  test('says a good plugin is good, and what it contributes', async () => {
    offered('good')
    writeFileSync(
      join(cwd, '.aidcrew', 'plugins', 'good', 'index.ts'),
      `import { definePlugin, defineTool } from '@aidcrew/plugin-sdk'
       import { z } from 'zod'
       export default definePlugin({
         name: 'good',
         tools: [defineTool({ name: 'a', description: 'Does a thing.', schema: z.object({}), run: async () => ({ content: '' }) })],
       })`,
    )

    expect(
      await runPlugins(['check', join(cwd, '.aidcrew', 'plugins', 'good')], store, io(), cwd, home),
    ).toBe(0)
    expect(out.join('')).toContain('1 tool')
  })

  test('says exactly what the host would say, and fails', async () => {
    offered('bad')
    writeFileSync(
      join(cwd, '.aidcrew', 'plugins', 'bad', 'index.ts'),
      `export default { name: 'bad', hooks: [{ preTurn: async () => undefined }] }`,
    )

    expect(
      await runPlugins(['check', join(cwd, '.aidcrew', 'plugins', 'bad')], store, io(), cwd, home),
    ).toBe(1)
    expect(errors.join('')).toMatch(/hooks.*object.*array/i)
  })

  test('warnings are shown without failing', async () => {
    offered('odd')
    writeFileSync(
      join(cwd, '.aidcrew', 'plugins', 'odd', 'index.ts'),
      `export default { name: 'odd', tool: [] }`,
    )

    expect(
      await runPlugins(['check', join(cwd, '.aidcrew', 'plugins', 'odd')], store, io(), cwd, home),
    ).toBe(0)
    expect(out.join('') + errors.join('')).toMatch(/"tool"/)
  })

  test('a directory with no plugin in it says so', async () => {
    expect(await runPlugins(['check', cwd], store, io(), cwd, home)).toBe(1)
    expect(errors.join('')).toMatch(/index\.ts/)
  })
})

describe('check with a relative path', () => {
  test('works, because that is how anybody would type it', async () => {
    // In a compiled binary a bare relative specifier resolves against the
    // bundle rather than the working directory, so `plugin check
    // .aidcrew/plugins/mine` failed with "Cannot find module ... from
    // /$bunfs/root/main.js" — which reads like the plugin is broken.
    offered('here')

    expect(
      await runPlugins(['check', join('.aidcrew', 'plugins', 'here')], store, io(), cwd, home),
    ).toBe(0)
    expect(out.join('')).toContain('here')
  })
})

describe('check on a plugin that builds itself', () => {
  test('runs setup, so it reports what the plugin really supplies', async () => {
    // Reporting the static shape of a plugin whose whole capability comes
    // from setup means saying "supplies nothing" about a plugin that supplies
    // a tool — which is worse than saying nothing at all.
    offered('built')
    writeFileSync(
      join(cwd, '.aidcrew', 'plugins', 'built', 'index.ts'),
      `import { definePlugin, defineTool } from '@aidcrew/plugin-sdk'
       import { z } from 'zod'
       export default definePlugin({
         name: 'built',
         setup: () => ({ tools: [defineTool({ name: 'made', description: 'Built in setup.', schema: z.object({}), run: async () => ({ content: '' }) })] }),
       })`,
    )

    expect(
      await runPlugins(
        ['check', join(cwd, '.aidcrew', 'plugins', 'built')],
        store,
        io(),
        cwd,
        home,
      ),
    ).toBe(0)
    expect(out.join('')).toContain('1 tool')
  })

  test('what a plugin says while setting itself up is printed, not swallowed', async () => {
    // Every host that loads a plugin gives it a way to say something, and what
    // it says while being set up — "the variable holding the token is not set,
    // so this will only work locally" — is exactly what the author ran the
    // check to find out. A checker that drops it reports a working plugin and
    // withholds the reason it will not work.
    offered('talkative')
    writeFileSync(
      join(cwd, '.aidcrew', 'plugins', 'talkative', 'index.ts'),
      `export default {
         name: 'talkative',
         setup: (host) => {
           host.say?.('STANDUP_TOKEN is not set, so notes stay local.')
           return {}
         },
       }`,
    )

    expect(
      await runPlugins(
        ['check', join(cwd, '.aidcrew', 'plugins', 'talkative')],
        store,
        io(),
        cwd,
        home,
      ),
    ).toBe(0)
    expect(out.join('')).toContain('STANDUP_TOKEN is not set')
  })

  test('a setup that needs settings says so instead of failing mysteriously', async () => {
    offered('needy')
    writeFileSync(
      join(cwd, '.aidcrew', 'plugins', 'needy', 'index.ts'),
      `export default { name: 'needy', setup: () => { throw new Error('needs a team') } }`,
    )

    expect(
      await runPlugins(
        ['check', join(cwd, '.aidcrew', 'plugins', 'needy')],
        store,
        io(),
        cwd,
        home,
      ),
    ).toBe(1)
    expect(errors.join('')).toContain('needs a team')
    expect(errors.join('')).toMatch(/settings|configur/i)
  })

  test('warns about what setup built, not only about what was written', async () => {
    // A one-letter capability typo is the whole reason warnings exist, and a
    // plugin whose capabilities are built is exactly where one hides.
    const directory = written(
      'typo',
      `export default { name: 'typo', setup: () => ({ tool: [] }) }`,
    )

    expect(await runPlugins(['check', directory], store, io(), cwd, home)).toBe(0)
    expect(out.join('') + errors.join('')).toMatch(/"tool"/)
  })

  test('leaves nothing behind in the directory it was asked to inspect', async () => {
    // An inspection that invites a stranger's code to write into the checkout
    // is an inspection nobody can run twice and trust the second answer.
    const directory = written(
      'writer',
      `import { writeFile } from 'node:fs/promises'
       import { join } from 'node:path'
       export default {
         name: 'writer',
         setup: async (host) => {
           await writeFile(join(await host.stateDir(), 'cache'), 'x')
           await writeFile(join(host.home, 'cache'), 'x')
         },
       }`,
    )

    expect(await runPlugins(['check', directory], store, io(), cwd, home)).toBe(0)
    expect(readdirSync(directory)).toEqual(['index.ts'])
    expect(readdirSync(home)).not.toContain('cache')
  })
})

describe('check on a plugin that needs settings', () => {
  test('hands setup the table this project declares, as the host does', async () => {
    // The checker is believed because it is the loader. One that runs a plugin
    // on settings the host would never give it is one that fails the plugin
    // the host loads happily, and sends its author round in a circle.
    const directory = written(
      'tracker',
      `export default {
         name: 'tracker',
         setup: (host) => {
           if (host.config.team === undefined) throw new Error('needs a team')
         },
       }`,
    )
    configured('[plugins.tracker]\nteam = "core"\n')

    expect(await runPlugins(['check', directory], store, io(), cwd, home)).toBe(0)
    expect(out.join('')).toContain('valid plugin')
  })

  test('does not advise filling in a table this project has already filled in', async () => {
    const directory = written(
      'tracker',
      `export default { name: 'tracker', setup: () => { throw new Error('needs a board too') } }`,
    )
    configured('[plugins.tracker]\nteam = "core"\n')

    expect(await runPlugins(['check', directory], store, io(), cwd, home)).toBe(1)
    expect(errors.join('')).toContain('needs a board too')
    expect(errors.join('')).not.toMatch(/table filled in/)
  })

  test('says the project config is broken rather than guessing what it said', async () => {
    const directory = written(
      'tracker',
      `export default { name: 'tracker', setup: () => undefined }`,
    )
    configured('[plugins\nteam = ')

    expect(await runPlugins(['check', directory], store, io(), cwd, home)).toBe(1)
    expect(errors.join('')).toMatch(/config\.toml/)
  })
})
