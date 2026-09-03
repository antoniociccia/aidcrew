import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadPluginsFrom } from './loader.ts'

let root: string

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-plugins-')))
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

/** Writes a plugin directory containing `source` as its entry point. */
function plugin(name: string, source: string, entry = 'index.ts'): void {
  mkdirSync(join(root, name), { recursive: true })
  writeFileSync(join(root, name, entry), source)
}

const workingPlugin = (name: string) => `
  export default {
    name: '${name}',
    tools: [{
      name: '${name}-tool',
      description: 'test',
      inputSchema: { type: 'object' },
      execute: async () => ({ content: 'ok' }),
    }],
  }
`

describe('loadPluginsFrom', () => {
  test('loads a plugin from its index', async () => {
    plugin('alpha', workingPlugin('alpha'))

    const result = await loadPluginsFrom([root])

    expect(result.loaded.map((p) => p.name)).toEqual(['alpha'])
    expect(result.failed).toEqual([])
  })

  test('accepts plugin.ts as an entry point too', async () => {
    plugin('beta', workingPlugin('beta'), 'plugin.ts')

    const result = await loadPluginsFrom([root])

    expect(result.loaded.map((p) => p.name)).toEqual(['beta'])
  })

  test('loads plugins in a stable alphabetical order', async () => {
    // Hook order follows load order, so it must not depend on the filesystem.
    plugin('gamma', workingPlugin('gamma'))
    plugin('alpha', workingPlugin('alpha'))
    plugin('beta', workingPlugin('beta'))

    const result = await loadPluginsFrom([root])

    expect(result.loaded.map((p) => p.name)).toEqual(['alpha', 'beta', 'gamma'])
  })

  test('reports a broken plugin instead of failing the whole startup', async () => {
    plugin('good', workingPlugin('good'))
    plugin('broken', 'throw new Error("boom at import time")')

    const result = await loadPluginsFrom([root])

    expect(result.loaded.map((p) => p.name)).toEqual(['good'])
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0]?.reason).toMatch(/boom at import time/)
  })

  test('rejects a module with no default export', async () => {
    plugin('naked', 'export const something = 1')

    const result = await loadPluginsFrom([root])

    expect(result.loaded).toHaveLength(0)
    expect(result.failed[0]?.reason).toMatch(/default export/)
  })

  test('rejects a default export that is not shaped like a plugin', async () => {
    plugin('wrong', 'export default { tools: [] }')

    const result = await loadPluginsFrom([root])

    expect(result.failed[0]?.reason).toMatch(/name/)
  })

  test('rejects a plugin whose tools are not tools', async () => {
    plugin('bad-tools', "export default { name: 'bad-tools', tools: 'not an array' }")

    const result = await loadPluginsFrom([root])

    expect(result.failed[0]?.reason).toMatch(/tools/)
  })

  test('ignores loose files that are not plugin directories', async () => {
    writeFileSync(join(root, 'README.md'), '# not a plugin')
    plugin('alpha', workingPlugin('alpha'))

    const result = await loadPluginsFrom([root])

    expect(result.loaded).toHaveLength(1)
    expect(result.failed).toHaveLength(0)
  })

  test('ignores a directory with no entry point at all', async () => {
    mkdirSync(join(root, 'empty-dir'))
    plugin('alpha', workingPlugin('alpha'))

    const result = await loadPluginsFrom([root])

    expect(result.loaded).toHaveLength(1)
    expect(result.failed).toHaveLength(0)
  })

  test('treats a missing plugin directory as empty, not as an error', async () => {
    const result = await loadPluginsFrom([join(root, 'does-not-exist')])

    expect(result.loaded).toEqual([])
    expect(result.failed).toEqual([])
  })

  test('searches several directories, later ones after earlier ones', async () => {
    const second = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-plugins2-')))
    mkdirSync(join(second, 'zeta'))
    writeFileSync(join(second, 'zeta', 'index.ts'), workingPlugin('zeta'))
    plugin('alpha', workingPlugin('alpha'))

    const result = await loadPluginsFrom([root, second])

    expect(result.loaded.map((p) => p.name)).toEqual(['alpha', 'zeta'])
    rmSync(second, { recursive: true, force: true })
  })

  test('records where each plugin was loaded from', async () => {
    plugin('alpha', workingPlugin('alpha'))

    const result = await loadPluginsFrom([root])

    expect(result.loaded[0]?.name).toBe('alpha')
    expect(result.sources.get('alpha')).toContain(join(root, 'alpha'))
  })
})

describe('what a broken plugin is told to its author', () => {
  test('a syntax error says what and where, not how many', async () => {
    // Bun reports a build failure as an AggregateError whose message is only
    // a count — "3 errors building index.ts" — with the actual complaints in
    // `.errors`. A plugin author reading "3 errors" learns nothing, and this
    // is the first thing that happens to anyone writing their first plugin.
    plugin('wonky', 'this is not valid typescript at all !!!\n')

    const result = await loadPluginsFrom([root])

    expect(result.loaded).toHaveLength(0)
    expect(result.failed[0]?.reason).toContain('Expected ";"')
  })

  test('a plugin that throws while loading says what it threw', async () => {
    plugin('angry', "throw new Error('needs FOO in the environment')\n")

    const result = await loadPluginsFrom([root])

    expect(result.failed[0]?.reason).toBe('needs FOO in the environment')
  })

  test('several complaints are shown, but not a screenful of them', async () => {
    plugin('worse', `${'this is not valid ts !!!\n'.repeat(20)}`)

    const result = await loadPluginsFrom([root])

    const reason = result.failed[0]?.reason ?? ''
    expect(reason).toContain('Expected ";"')
    expect(reason).toContain('more)')
    expect(reason.split('\n')).toHaveLength(1)
  })
})

describe('loading again after a plugin changed', () => {
  test('the new version is what comes back', async () => {
    // Bun caches a module by path, so a second `import` of an edited file
    // returns the old one. Without this, "hot reload" means "reload that
    // silently does nothing", which is worse than no hot reload at all: you
    // edit, you save, you see the old behaviour, and you blame your edit.
    plugin('shifty', workingPlugin('shifty'))
    const before = await loadPluginsFrom([root])
    expect(before.loaded[0]?.version).toBeUndefined()

    writeFileSync(
      join(root, 'shifty', 'index.ts'),
      `export default { name: 'shifty', version: '2.0.0' }`,
    )

    const after = await loadPluginsFrom([root], { fresh: true })

    expect(after.loaded[0]?.version).toBe('2.0.0')
  })

  test('without asking, the cached one is fine and cheaper', async () => {
    plugin('steady', workingPlugin('steady'))
    await loadPluginsFrom([root])
    writeFileSync(
      join(root, 'steady', 'index.ts'),
      `export default { name: 'steady', version: '9' }`,
    )

    const again = await loadPluginsFrom([root])

    expect(again.loaded[0]?.version).toBeUndefined()
  })
})

describe('the same directory named twice', () => {
  test('is read once', async () => {
    // The user directory and the project directory are the same directory
    // whenever somebody opens their home as a project. Reading it twice made
    // every plugin in it a duplicate of itself, refused with the memorable
    // message: plugin "live" is provided by both "live" and "live".
    plugin('twice', workingPlugin('twice'))

    const result = await loadPluginsFrom([root, root])

    expect(result.loaded).toHaveLength(1)
    expect(result.failed).toEqual([])
  })

  test('and so is one reached by a different spelling of the same path', async () => {
    plugin('spelled', workingPlugin('spelled'))

    const result = await loadPluginsFrom([root, join(root, '.', '')])

    expect(result.loaded).toHaveLength(1)
  })
})

describe('being asked before a plugin runs', () => {
  test('a plugin nobody has allowed is not imported at all', async () => {
    // Not "loaded and then ignored": *not imported*. A module's top-level
    // code runs on import, so a decision taken after the import is a decision
    // taken after the damage. This is the whole point of the callback.
    plugin(
      'stranger',
      'await Bun.write(`${import.meta.dir}/ran`, "yes")\nexport default { name: "stranger" }',
    )

    const result = await loadPluginsFrom([{ path: root, scope: 'project' }], {
      allow: () => false,
    })

    expect(result.loaded).toEqual([])
    expect(existsSync(join(root, 'stranger', 'ran'))).toBe(false)
    expect(result.refused.map((one) => one.name)).toEqual(['stranger'])
  })

  test('one that is allowed loads as before', async () => {
    plugin('welcome', workingPlugin('welcome'))

    const result = await loadPluginsFrom([{ path: root, scope: 'project' }], { allow: () => true })

    expect(result.loaded.map((p) => p.name)).toEqual(['welcome'])
    expect(result.refused).toEqual([])
  })

  test('the question carries where it came from and what it is called', async () => {
    plugin('asked-about', workingPlugin('asked-about'))
    const questions: { name: string; path: string; scope: string }[] = []

    await loadPluginsFrom([{ path: root, scope: 'project' }], {
      allow: (candidate) => {
        questions.push(candidate)
        return false
      },
    })

    expect(questions[0]?.name).toBe('asked-about')
    expect(questions[0]?.scope).toBe('project')
    expect(questions[0]?.path).toContain('asked-about')
  })

  test("a plain path is the user's own and is not asked about", async () => {
    // Somebody's own plugin directory is somebody's own decision, already
    // made when they put the file there. Asking would train them to say yes.
    plugin('mine', workingPlugin('mine'))
    let asked = 0

    const result = await loadPluginsFrom([root], {
      allow: () => {
        asked += 1
        return false
      },
    })

    expect(asked).toBe(0)
    expect(result.loaded.map((p) => p.name)).toEqual(['mine'])
  })
})

describe('a plugin that loads but has something odd in it', () => {
  test('the oddity is reported without refusing the plugin', async () => {
    plugin('typo', `export default { name: 'typo', tool: [] }`)

    const result = await loadPluginsFrom([root])

    expect(result.loaded.map((p) => p.name)).toEqual(['typo'])
    expect(result.warnings[0]?.reason).toMatch(/"tool".*"tools"/)
    expect(result.warnings[0]?.path).toContain('typo')
  })

  test('a plugin with nothing odd produces no noise', async () => {
    plugin('tidy', workingPlugin('tidy'))

    const result = await loadPluginsFrom([root])

    expect(result.warnings).toEqual([])
  })
})
