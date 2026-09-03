import type { Dirent } from 'node:fs'
import { readdir, readFile, readlink, realpath, stat } from 'node:fs/promises'
import { join, relative, sep } from 'node:path'
import { defineTool } from '@aidcrew/plugin-sdk'
import { explainMissing, resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'
import { compileIgnore, type Verdict } from './ignore.ts'

/**
 * The shape of a directory, without the parts nobody means.
 *
 * `find` through three greps is what an agent does today to see what a
 * package contains, because the honest listing is nine tenths node_modules.
 * This skips what git skips, stops at a depth and at a count, and says how
 * much it left out, so the answer is small and the model knows it is partial.
 */

/** Skipped whatever any .gitignore says: never the answer, always enormous. */
const ALWAYS_SKIPPED = new Set(['node_modules', '.git', 'dist', '.aidcrew'])
const DEFAULT_DEPTH = 2
const MAX_DEPTH = 10
/** Enough to see a package whole, few enough to read in one look. */
const ENTRY_LIMIT = 200
const MAX_ENTRY_LIMIT = 1000

type Node = {
  name: string
  kind: 'directory' | 'file' | 'link'
  /** For a directory the listing did not descend into: how much it holds. */
  entries?: number
  /** Where a symlink points. */
  target?: string
  children: Node[]
}

/** The rules of every .gitignore met so far, each with the directory it governs. */
type IgnoreRules = { files: { base: string; verdict: Verdict }[]; loaded: Set<string> }

export const treeTool = defineTool({
  name: 'tree',
  reads: true,
  description:
    'Show the directories and files under a path as an indented tree, directories first, ' +
    'skipping node_modules, build output and whatever .gitignore skips. Use it to learn the ' +
    'shape of a package before reading or searching; use glob to find files by name.',
  schema: z.object({
    path: z.string().optional().describe('Directory to show, relative to the workspace.'),
    depth: z
      .number()
      .int()
      .min(1)
      .max(MAX_DEPTH)
      .optional()
      .describe('How many levels down to show. Default 2.'),
    limit: z
      .number()
      .int()
      .min(1)
      .max(MAX_ENTRY_LIMIT)
      .optional()
      .describe('Stop after this many entries. Default 200.'),
  }),
  async run({ path = '.', depth = DEFAULT_DEPTH, limit = ENTRY_LIMIT }, { cwd }) {
    const root = resolveInWorkspace(cwd, path)

    let info: Awaited<ReturnType<typeof stat>>
    try {
      info = await stat(root)
    } catch {
      return { content: explainMissing(cwd, path) ?? `${path} does not exist`, isError: true }
    }
    if (!info.isDirectory()) {
      return {
        content: `${path} is a file, not a directory; use stat to size it or read to read it`,
        isError: true,
      }
    }

    const workspace = await realpath(cwd)
    const rules = await rulesAbove(workspace, root)
    const listing = await walk({
      root,
      base: toPosix(relative(workspace, root)),
      depth,
      limit,
      rules,
    })

    const shown = path.replace(/[/\\]+$/, '') || '.'
    if (listing.tree.children.length === 0) {
      const raw = await readdir(root).catch(() => [])
      return {
        content:
          raw.length === 0
            ? `${shown} is empty`
            : `${shown} holds only entries this listing skips: node_modules, .git, dist, ` +
              '.aidcrew, or what .gitignore ignores',
      }
    }

    const lines = [`${shown}/`]
    render(listing.tree, 1, lines)
    lines.push(
      `${count(listing.directories, 'directory', 'directories')}, ${count(listing.files, 'file', 'files')}`,
    )
    if (listing.hidden > 0) {
      lines.push(
        `... ${listing.hidden} more entries not shown (limit ${limit}); ask for a narrower path or a smaller depth`,
      )
    }
    return { content: lines.join('\n') }
  },
})

/** A directory waiting to be listed, and the node its entries go under. */
type Pending = { node: Node; dir: string; rel: string; level: number }

type Walk = { root: string; base: string; depth: number; limit: number; rules: IgnoreRules }

/**
 * Lists level by level rather than branch by branch, so that when the cap is
 * hit every top-level entry has been seen and it is the deep ones that go
 * unshown. A depth-first walk spends the whole budget inside the first
 * directory and never mentions the other nine.
 */
async function walk(
  options: Walk,
): Promise<{ tree: Node; hidden: number; directories: number; files: number }> {
  const tree: Node = { name: '', kind: 'directory', children: [] }
  const queue: Pending[] = [{ node: tree, dir: options.root, rel: options.base, level: 0 }]
  const tally = { shown: 0, hidden: 0, directories: 0, files: 0 }

  for (let next = 0; next < queue.length; next += 1) {
    const pending = queue[next] as Pending

    for (const entry of await visible(pending.dir, pending.rel, options.rules)) {
      if (tally.shown >= options.limit) {
        tally.hidden += 1
        continue
      }
      tally.shown += 1

      const child = await describe(entry, pending, options)
      pending.node.children.push(child)
      if (child.kind !== 'directory') {
        tally.files += 1
        continue
      }

      tally.directories += 1
      // A directory the depth allows into is listed in its turn; one it does
      // not was given its size by `describe` instead.
      if (child.entries === undefined) {
        queue.push({
          node: child,
          dir: join(pending.dir, entry.name),
          rel: below(pending.rel, entry.name),
          level: pending.level + 1,
        })
      }
    }
  }

  return { tree, ...tally }
}

/** One entry as a node: a link with its target, a cut-off directory with its size, or a name. */
async function describe(entry: Dirent, parent: Pending, options: Walk): Promise<Node> {
  const child: Node = { name: entry.name, kind: kindOf(entry), children: [] }
  const path = join(parent.dir, entry.name)

  if (child.kind === 'link') child.target = await readlink(path).catch(() => '?')
  if (child.kind === 'directory' && parent.level + 1 >= options.depth) {
    child.entries = (await visible(path, below(parent.rel, entry.name), options.rules)).length
  }
  return child
}

function below(rel: string, name: string): string {
  return rel === '' ? name : `${rel}/${name}`
}

/** A directory's entries as the listing shows them: filtered, directories first, sorted. */
async function visible(dir: string, rel: string, rules: IgnoreRules): Promise<Dirent[]> {
  let entries: Dirent[]
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return []
  }

  // A directory's own .gitignore governs its entries, so it is read before
  // they are filtered — including the .gitignore itself, which git shows.
  if (entries.some((entry) => entry.name === '.gitignore' && entry.isFile())) {
    await learn(rules, dir, rel)
  }

  return entries
    .filter((entry) => !ignored(rules, rel, entry.name, entry.isDirectory()))
    .sort((a, b) => rank(a) - rank(b) || compare(a.name, b.name))
}

/** The .gitignore files between the workspace root and the directory shown, root first. */
async function rulesAbove(workspace: string, root: string): Promise<IgnoreRules> {
  const rules: IgnoreRules = { files: [], loaded: new Set() }
  const segments = toPosix(relative(workspace, root))
    .split('/')
    .filter((part) => part !== '')

  for (let depth = 0; depth < segments.length; depth += 1) {
    const above = segments.slice(0, depth)
    await learn(rules, join(workspace, ...above), above.join('/'))
  }
  return rules
}

async function learn(rules: IgnoreRules, dir: string, base: string): Promise<void> {
  if (rules.loaded.has(base)) return
  rules.loaded.add(base)

  const body = await readFile(join(dir, '.gitignore'), 'utf8').catch(() => undefined)
  if (body !== undefined) rules.files.push({ base, verdict: compileIgnore(body) })
}

/**
 * Whether an entry is left out. The always-skipped names come first; after
 * them every .gitignore whose directory contains the entry gets a say, and
 * the deepest one that says anything wins, as in git.
 */
function ignored(rules: IgnoreRules, rel: string, name: string, isDirectory: boolean): boolean {
  if (ALWAYS_SKIPPED.has(name)) return true

  const path = rel === '' ? name : `${rel}/${name}`
  let verdict = false
  for (const file of rules.files) {
    if (file.base !== '' && !path.startsWith(`${file.base}/`)) continue
    const answer = file.verdict(
      file.base === '' ? path : path.slice(file.base.length + 1),
      isDirectory,
    )
    if (answer !== undefined) verdict = answer
  }
  return verdict
}

function render(node: Node, level: number, out: string[]): void {
  for (const child of node.children) {
    out.push(`${'  '.repeat(level)}${label(child)}`)
    render(child, level + 1, out)
  }
}

function label(node: Node): string {
  if (node.kind === 'link') return `${node.name} -> ${node.target ?? '?'}`
  if (node.kind === 'file') return node.name
  if (node.entries === undefined) return `${node.name}/`
  return node.entries === 0
    ? `${node.name}/ (empty)`
    : `${node.name}/ (${count(node.entries, 'entry', 'entries')})`
}

function kindOf(entry: Dirent): Node['kind'] {
  if (entry.isSymbolicLink()) return 'link'
  return entry.isDirectory() ? 'directory' : 'file'
}

function rank(entry: Dirent): number {
  return entry.isDirectory() ? 0 : 1
}

function compare(a: string, b: string): number {
  if (a < b) return -1
  return a > b ? 1 : 0
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}

function toPosix(path: string): string {
  return sep === '/' ? path : path.split(sep).join('/')
}
