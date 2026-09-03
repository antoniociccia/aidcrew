import { stat } from 'node:fs/promises'
import { basename, dirname, join, relative, resolve, sep } from 'node:path'
import { defineTool } from '@aidcrew/plugin-sdk'
import { explainMissing, resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'
import { displayPath, readIfText, SOURCE_EXTENSIONS, SOURCE_GLOB, walk } from './walk.ts'

/**
 * What a file depends on, and what depends on it.
 *
 * The second is the one that matters — "what breaks if I change this" — and
 * it was a grep for the file's name whose answer had to be read and filtered
 * by hand, because an importer can spell the same file five ways: with the
 * extension, without it, as `.js` for a `.ts` (which tsc asks for), as the
 * directory whose index it is, or by the package name that exports it. All
 * five are resolved here against each importer, and matched by path.
 */

/** Importers per call. A file with more than this is a foundation, not a file. */
const LIMIT = 100

type Found = { specifier: string; line: number }

export const importsTool = defineTool({
  name: 'imports',
  reads: true,
  description:
    'What a file imports (static, dynamic and require, each once), or with whoImports the files in ' +
    'the workspace that import it — by relative path or by package name. Set whoImports to learn ' +
    'what breaks if a file changes, instead of grepping for its name.',
  schema: z.object({
    path: z.string().describe('The file, relative to the workspace.'),
    whoImports: z
      .boolean()
      .optional()
      .describe('List the files that import this one instead of what it imports.'),
  }),
  async run({ path, whoImports = false }, { cwd }) {
    const resolved = resolveInWorkspace(cwd, path)

    const info = await stat(resolved).catch(() => undefined)
    if (info === undefined) {
      return { content: explainMissing(cwd, path) ?? `${path} does not exist`, isError: true }
    }
    if (info.isDirectory()) {
      return { content: `${path} is a directory; imports takes one file`, isError: true }
    }

    if (whoImports) return await importersOf(cwd, resolved, path)

    const text = await readIfText(resolved)
    if (text === undefined) {
      return { content: `${path} is binary or too large to read`, isError: true }
    }

    const found = specifiers(text)
    if (found.length === 0) return { content: `${path} imports nothing` }
    return { content: found.map((entry) => entry.specifier).join('\n') }
  },
})

/**
 * Static imports and re-exports, anchored at the start of a line so that a
 * comment or a string quoting one is not counted; the span between the
 * keyword and `from` may cross lines (a long import list) but not a quote or a
 * semicolon, which is what stops it reaching into the next statement.
 */
const STATIC = /^[ \t]*(?:import\b|export\s+(?:type\s+)?[*{])[^;'"`]*?\bfrom\s*['"]([^'"]+)['"]/gm
const SIDE_EFFECT = /^[ \t]*import\s*['"]([^'"]+)['"]/gm
/** These two sit inside code, so they are looked for anywhere. */
const DYNAMIC = /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g
const REQUIRE = /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g

/** Every module `text` imports, each once, at the first line it does so. */
function specifiers(text: string): Found[] {
  const first = new Map<string, number>()

  for (const matcher of [STATIC, SIDE_EFFECT, DYNAMIC, REQUIRE]) {
    for (const match of text.matchAll(matcher)) {
      const specifier = match[1]
      if (specifier === undefined) continue
      const line = lineOf(text, match.index)
      const known = first.get(specifier)
      if (known === undefined || line < known) first.set(specifier, line)
    }
  }

  return [...first]
    .map(([specifier, line]) => ({ specifier, line }))
    .sort((a, b) => a.line - b.line)
}

function lineOf(text: string, index: number): number {
  let line = 1
  for (let at = 0; at < index; at += 1) if (text.charCodeAt(at) === 10) line += 1
  return line
}

/** The files under the workspace whose imports resolve to `target`. */
async function importersOf(cwd: string, target: string, path: string) {
  const root = resolveInWorkspace(cwd, '.')
  const names = await packageNamesOf(root, target)

  // A file that imports the target has to mention its stem, its directory (when
  // it is an index) or the package that exports it. Most files mention none.
  const stem = basename(target).replace(/\.[^.]+$/, '')
  const needles = [stem, ...names]
  if (stem === 'index') needles.push(basename(dirname(target)))

  const found: string[] = []
  let cut = false
  for await (const file of walk(root, SOURCE_GLOB)) {
    if (file === target) continue
    const text = await readIfText(file)
    if (text === undefined || !needles.some((needle) => text.includes(needle))) continue

    const hit = specifiers(text).find((entry) => pointsAt(file, entry.specifier, target, names))
    if (hit === undefined) continue
    if (found.length >= LIMIT) {
      cut = true
      break
    }
    found.push(`${displayPath(cwd, file)}:${hit.line}`)
  }

  if (found.length === 0) return { content: `nothing in the workspace imports ${path}` }
  return {
    content: cut
      ? `${found.join('\n')}\n... and more, past the limit of ${LIMIT}`
      : found.join('\n'),
  }
}

function pointsAt(importer: string, specifier: string, target: string, names: string[]): boolean {
  if (specifier.startsWith('.')) {
    return candidates(resolve(dirname(importer), specifier)).includes(target)
  }
  return names.includes(specifier)
}

/** The files a specifier resolving to `base` can mean, the way bundlers and tsc read it. */
function candidates(base: string): string[] {
  const files = [
    base,
    ...SOURCE_EXTENSIONS.map((ext) => base + ext),
    ...SOURCE_EXTENSIONS.map((ext) => join(base, `index${ext}`)),
  ]
  // TypeScript asks an import to name the emitted file: `./x.js` means `./x.ts`.
  const emitted = /\.jsx?$/.exec(base)
  if (emitted !== null) {
    const stem = base.slice(0, -emitted[0].length)
    files.push(`${stem}.tsx`)
    if (emitted[0] === '.js') files.push(`${stem}.ts`)
  }
  return files
}

/**
 * The package names under which `target` can be imported, from the nearest
 * package.json above it: the bare name when the file is its `main` or its
 * `"."` export, `name/sub` for a subpath export, including one declared with a
 * wildcard (`"./*": "./src/*.ts"`).
 */
async function packageNamesOf(root: string, target: string): Promise<string[]> {
  for (let dir = dirname(target); ; dir = dirname(dir)) {
    const text = await Bun.file(join(dir, 'package.json'))
      .text()
      .catch(() => undefined)
    if (text !== undefined) return namesIn(dir, parse(text), target)
    if (dir === root || dirname(dir) === dir) return []
  }
}

function parse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    // A package.json that is not JSON exports nothing anyone can import.
    return undefined
  }
}

function namesIn(packageDir: string, manifest: unknown, target: string): string[] {
  if (typeof manifest !== 'object' || manifest === null) return []
  const { name, main, exports } = manifest as { name?: unknown; main?: unknown; exports?: unknown }
  if (typeof name !== 'string') return []

  if (exports === undefined) {
    // Without an exports map, the package is its main file, index.js by default.
    const entry = typeof main === 'string' ? main : './index.js'
    return candidates(resolve(packageDir, entry)).includes(target) ? [name] : []
  }

  const rel = `./${relative(packageDir, target).split(sep).join('/')}`
  const found = subpaths(exports).flatMap(([subpath, values]) =>
    values
      .map((value) => exportedAs(subpath, value, rel, packageDir, target))
      .filter((exported): exported is string => exported !== undefined),
  )
  return [...new Set(found)].map((exported) => (exported === '.' ? name : name + exported.slice(1)))
}

/** The subpath `target` is exported under by one exports entry, if it is. */
function exportedAs(
  subpath: string,
  value: string,
  rel: string,
  packageDir: string,
  target: string,
): string | undefined {
  const star = value.indexOf('*')
  if (star === -1) {
    return candidates(resolve(packageDir, value)).includes(target) ? subpath : undefined
  }
  const prefix = value.slice(0, star)
  const suffix = value.slice(star + 1)
  const fits =
    rel.startsWith(prefix) && rel.endsWith(suffix) && rel.length > prefix.length + suffix.length
  if (!fits) return undefined
  return subpath.replace('*', rel.slice(prefix.length, rel.length - suffix.length))
}

/** The `exports` field as (subpath, file patterns) pairs, whichever of its shapes it takes. */
function subpaths(exports: unknown): [string, string[]][] {
  if (typeof exports === 'string' || Array.isArray(exports)) return [['.', stringsIn(exports)]]
  if (typeof exports !== 'object' || exports === null) return []

  const entries = Object.entries(exports)
  // A map whose keys are conditions ("import", "default") rather than
  // subpaths describes the "." entry alone.
  if (entries.every(([key]) => !key.startsWith('.'))) return [['.', stringsIn(exports)]]
  return entries
    .filter(([key]) => key.startsWith('.'))
    .map(([key, value]) => [key, stringsIn(value)])
}

/** Every string inside a (possibly nested, possibly conditional) exports value. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value]
  if (Array.isArray(value)) return value.flatMap(stringsIn)
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn)
  return []
}
