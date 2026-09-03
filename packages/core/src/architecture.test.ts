import { describe, expect, test } from 'bun:test'
import { readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

/**
 * The thesis, enforced.
 *
 * "Everything is a plugin" is a claim that decays the moment someone reaches
 * for a shortcut, and a shortcut here looks perfectly reasonable in review:
 * one import of one tool, just this once. These tests make that import fail
 * the build instead.
 */

const coreSrc = dirname(new URL(import.meta.url).pathname)
const repoRoot = join(coreSrc, '..', '..', '..')

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((entry) => {
    // Never into node_modules: every plugin has one, each a link back to the
    // workspace's own packages and to zod, and following them read thousands
    // of files that are not this project's — enough to trip the per-test
    // timeout on a shared runner.
    if (entry === 'node_modules') return []
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) return sourceFiles(full)
    return full.endsWith('.ts') && !full.endsWith('.test.ts') ? [full] : []
  })
}

const IMPORT = /from\s+'([^']+)'/g
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g
const LINE_COMMENT = /\/\/.*$/gm

/**
 * What a file imports, ignoring what it talks about.
 *
 * This codebase explains itself in prose, and prose about plugins quotes the
 * import a plugin author writes. Counting that as an import made the rule
 * report the comment describing it as a violation of itself.
 */
function importsOf(file: string): string[] {
  const source = readFileSync(file, 'utf8')
    .replaceAll(BLOCK_COMMENT, '')
    .replaceAll(LINE_COMMENT, '')
  return [...source.matchAll(IMPORT)].map((match) => match[1] as string)
}

describe('the core knows nothing about plugins', () => {
  test('no core file imports a tool or provider package', () => {
    const offenders = sourceFiles(coreSrc).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => /^@aidcrew\/(tool|provider)-/.test(specifier))
        .map((specifier) => `${file.replace(repoRoot, '')} imports ${specifier}`),
    )

    expect(offenders).toEqual([])
  })

  test('the core has no runtime dependencies at all', () => {
    // Not asceticism: a core with dependencies is a core that has opinions
    // about how things are done, and those opinions leak into the contract.
    const manifest = JSON.parse(readFileSync(join(coreSrc, '..', 'package.json'), 'utf8')) as {
      dependencies?: Record<string, string>
    }

    expect(manifest.dependencies ?? {}).toEqual({})
  })

  test('no core file names a provider that exists in the world', () => {
    // The names of real services belong in the plugin that talks to them.
    const forbidden = /\b(openai|anthropic|deepseek|openrouter|gemini|ollama)\b/i
    const offenders = sourceFiles(coreSrc).filter((file) =>
      forbidden.test(readFileSync(file, 'utf8')),
    )

    expect(offenders.map((f) => f.replace(repoRoot, ''))).toEqual([])
  })

  test('the four bundled tools are not importable from the core', async () => {
    const core = (await import('./index.ts')) as Record<string, unknown>

    for (const name of ['readTool', 'writeTool', 'editTool', 'bashTool']) {
      expect(core[name]).toBeUndefined()
    }
  })

  test('no core file imports anything of ours at all', () => {
    // Wider than tools and providers on purpose: an import of the plugin SDK
    // would invert the relationship, and an import of the CLI would make the
    // core depend on a way of being used.
    const offenders = sourceFiles(coreSrc).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith('@aidcrew/'))
        .map((specifier) => `${file.replace(repoRoot, '')} imports ${specifier}`),
    )

    expect(offenders).toEqual([])
  })

  test('no core file reaches out of its own package by path', () => {
    // `src/plugins` is the core's own registry and contract, which is fine.
    // What is not is a relative path that climbs out of the package — the way
    // someone reaches a bundled plugin when the import would have been caught.
    const offenders = sourceFiles(coreSrc).flatMap((file) =>
      importsOf(file)
        .filter((specifier) => specifier.startsWith('../../'))
        .map((specifier) => `${file.replace(repoRoot, '')} imports ${specifier}`),
    )

    expect(offenders).toEqual([])
  })
})

describe('every capability is delivered as a plugin', () => {
  const pluginsDir = join(repoRoot, 'plugins')
  const bundled = readdirSync(pluginsDir).filter((entry) =>
    statSync(join(pluginsDir, entry)).isDirectory(),
  )

  test('there are bundled plugins to check, so this suite is not vacuous', () => {
    expect(bundled.length).toBeGreaterThan(4)
  })

  test('every bundled plugin declares itself through definePlugin', () => {
    // No privileged registration path: the plugins shipped in this repo go in
    // through the same door as one someone writes tonight. If that door were
    // not enough to build them, the contract would be wrong.
    const offenders = bundled.filter((name) => {
      const files = sourceFiles(join(pluginsDir, name, 'src'))
      return !files.some((file) => readFileSync(file, 'utf8').includes('definePlugin('))
    })

    expect(offenders).toEqual([])
  })

  test('every bundled plugin is TypeScript, with no build step to load it', () => {
    // A plugin is a module the host imports. Requiring a compile first would
    // mean nobody writes one to try an idea.
    const offenders = bundled.flatMap((name) => {
      const manifest = JSON.parse(readFileSync(join(pluginsDir, name, 'package.json'), 'utf8')) as {
        exports?: Record<string, string>
      }
      const entry = manifest.exports?.['.']
      return entry?.endsWith('.ts') ? [] : [`${name} is exported as ${entry}`]
    })

    expect(offenders).toEqual([])
  })

  test('the contract covers what the bundled plugins actually need', () => {
    // Each capability is exercised by something we ship. A field nothing uses
    // is a field nobody has proved is usable.
    const used = new Set<string>()
    for (const name of bundled) {
      for (const file of sourceFiles(join(pluginsDir, name, 'src'))) {
        const source = readFileSync(file, 'utf8')
        for (const capability of ['tools', 'providers', 'loaders', 'hooks']) {
          if (new RegExp(`\\b${capability}:`).test(source)) used.add(capability)
        }
      }
    }

    expect([...used].sort()).toEqual(['hooks', 'loaders', 'providers', 'tools'])
  })
})

describe('the rules themselves', () => {
  test('an import written about in a comment is not an import', () => {
    // The rule above is only worth having if it is accurate: one false
    // positive and the next person deletes it rather than the violation.
    const written = join(tmpdir(), `aidcrew-arch-${process.pid}.ts`)
    writeFileSync(
      written,
      `/**\n * Somebody writes: import { definePlugin } from '@aidcrew/plugin-sdk'\n */\n` +
        `// and also from '@aidcrew/tool-fs'\nimport { real } from './real.ts'\n`,
    )
    try {
      expect(importsOf(written)).toEqual(['./real.ts'])
    } finally {
      rmSync(written, { force: true })
    }
  })
})

describe('the bundled plugins are written the way a stranger would write one', () => {
  // The thesis, checked rather than asserted: the plugins that ship declare
  // their capabilities through the same helpers a third party has. When they
  // stop doing that, the helpers have stopped being enough — and nobody
  // outside would find out until they tried.
  const pluginsDir = join(dirname(dirname(coreSrc)), '..', 'plugins')

  test('every capability is declared through the SDK, not by hand', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(pluginsDir)) {
      const source = readFileSync(file, 'utf8')
        .replaceAll(/\/\*[\s\S]*?\*\//g, '')
        .replaceAll(/\/\/.*$/gm, '')
      const where = file.replace(repoRoot, '')

      // A capability handed to definePlugin as a bare literal is one nobody
      // checked the shape of. Every one of them has a define* helper now.
      if (/hooks:\s*\{/.test(source)) offenders.push(`${where}: hooks declared as a literal`)
      if (/ui:\s*\{/.test(source)) offenders.push(`${where}: ui declared as a literal`)
    }

    expect(offenders).toEqual([])
  })
})
