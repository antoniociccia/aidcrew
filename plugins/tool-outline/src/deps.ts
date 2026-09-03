import { basename, dirname, join, relative } from 'node:path'
import { defineTool } from '@aidcrew/plugin-sdk'
import { resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'
import { walk } from './walk.ts'

/**
 * What a package needs and what needs it.
 *
 * Answering "who depends on core" meant opening nineteen package.json files;
 * this opens them all at once, and only them. It reads the manifests rather
 * than asking a package manager, which would need a shell, an approval, and
 * an install state that agrees with the files.
 */

/** Dependents per call. A monorepo with more members than this has other problems. */
const LIMIT = 100

const SECTIONS = [
  'dependencies',
  'devDependencies',
  'peerDependencies',
  'optionalDependencies',
] as const
type Section = (typeof SECTIONS)[number]

const Versions = z.record(z.string(), z.string())
const Manifest = z.object({
  name: z.string().optional(),
  version: z.string().optional(),
  dependencies: Versions.optional(),
  devDependencies: Versions.optional(),
  peerDependencies: Versions.optional(),
  optionalDependencies: Versions.optional(),
  workspaces: z
    .union([z.array(z.string()), z.object({ packages: z.array(z.string()).optional() })])
    .optional(),
})
type Manifest = z.infer<typeof Manifest>

export const depsTool = defineTool({
  name: 'deps',
  reads: true,
  description:
    'What a workspace package depends on — its dependencies and devDependencies with versions — ' +
    'and which other packages in the monorepo depend on it, read from the package.json files ' +
    'without a package manager. Use it before changing a package to see what the change reaches.',
  schema: z.object({
    path: z
      .string()
      .describe('The package directory (or its package.json), relative to the workspace.'),
  }),
  async run({ path }, { cwd }) {
    const resolved = resolveInWorkspace(cwd, path)
    const manifestPath =
      basename(resolved) === 'package.json' ? resolved : join(resolved, 'package.json')
    const packageDir = dirname(manifestPath)

    const read = await readManifest(manifestPath)
    if ('problem' in read) {
      const shown = relative(cwd, manifestPath)
      if (read.problem === 'missing')
        return { content: `no package.json in ${path}`, isError: true }
      return { content: `${shown} ${read.problem}`, isError: true }
    }
    const manifest = read.manifest

    const root = resolveInWorkspace(cwd, '.')
    const lines = [
      heading(manifest, relative(root, packageDir) || '.'),
      ...section('dependencies', manifest),
      ...section('devDependencies', manifest),
      ...(manifest.peerDependencies ? section('peerDependencies', manifest) : []),
      ...(manifest.optionalDependencies ? section('optionalDependencies', manifest) : []),
      ...(await dependents(root, packageDir, manifest.name)),
    ]
    return { content: lines.join('\n') }
  },
})

function heading(manifest: Manifest, where: string): string {
  const name = manifest.name ?? '(unnamed)'
  return manifest.version ? `${name} ${manifest.version} (${where})` : `${name} (${where})`
}

function section(name: Section, manifest: Manifest): string[] {
  const entries = Object.entries(manifest[name] ?? {}).sort(([a], [b]) => a.localeCompare(b))
  if (entries.length === 0) return [`${name}: none`]
  return [`${name}:`, ...entries.map(([dependency, version]) => `  ${dependency} ${version}`)]
}

/**
 * The packages in the monorepo that list `name`, found through the root
 * package.json's `workspaces` globs — the same place the package manager
 * looks, and the only one: a manifest under node_modules or outside every
 * glob is not a member, whatever it says it needs.
 */
async function dependents(
  root: string,
  packageDir: string,
  name: string | undefined,
): Promise<string[]> {
  if (name === undefined)
    return ['depended on by: unknown — the package has no name to be depended on by']

  const rootRead = await readManifest(join(root, 'package.json'))
  if ('problem' in rootRead) {
    return [
      `depended on by: unknown — ${rootRead.problem === 'missing' ? 'no package.json' : `package.json ${rootRead.problem}`} at the workspace root`,
    ]
  }
  const globs = workspaceGlobs(rootRead.manifest)
  if (globs === undefined) {
    return ['depended on by: unknown — no "workspaces" in the package.json at the workspace root']
  }

  const found = await listingsUnder(root, globs, packageDir, name)
  // The root can depend on a member too, and does in this repository.
  if (packageDir !== root) found.push(...listing(rootRead.manifest, '.', name))

  if (found.length === 0) return ['depended on by: nothing in the workspace']
  found.sort()
  const shown = found.slice(0, LIMIT)
  const lines = ['depended on by:', ...shown.map((line) => `  ${line}`)]
  if (found.length > shown.length) lines.push(`  ... and ${found.length - shown.length} more`)
  return lines
}

/** The listings of `name` in every member's manifest, except the package's own. */
async function listingsUnder(
  root: string,
  globs: string[],
  packageDir: string,
  name: string,
): Promise<string[]> {
  const found: string[] = []
  for (const glob of globs) {
    for await (const file of walk(root, `${glob}/package.json`)) {
      const dir = dirname(file)
      if (dir === packageDir) continue
      const read = await readManifest(file)
      if ('problem' in read) continue
      found.push(...listing(read.manifest, relative(root, dir), name))
    }
  }
  return found
}

/** `name (where) section` for every section of `manifest` that lists `name`. */
function listing(manifest: Manifest, where: string, name: string): string[] {
  return SECTIONS.filter((section) => manifest[section]?.[name] !== undefined).map(
    (section) => `${manifest.name ?? '(unnamed)'} (${where}) ${section}`,
  )
}

function workspaceGlobs(manifest: Manifest): string[] | undefined {
  const { workspaces } = manifest
  if (workspaces === undefined) return undefined
  const globs = Array.isArray(workspaces) ? workspaces : (workspaces.packages ?? [])
  // A negated glob excludes; there is nothing to walk for it.
  return globs.filter((glob) => !glob.startsWith('!'))
}

/**
 * A manifest, or why it could not be one. Its shape is checked because it is
 * input: a `dependencies` that is a string would otherwise become a crash in
 * the middle of listing, after the model has already paid for the call.
 */
async function readManifest(
  path: string,
): Promise<{ manifest: Manifest } | { problem: 'missing' | string }> {
  const text = await Bun.file(path)
    .text()
    .catch(() => undefined)
  if (text === undefined) return { problem: 'missing' }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (cause) {
    return {
      problem: `is not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
    }
  }

  const checked = Manifest.safeParse(parsed)
  if (!checked.success) {
    const issues = checked.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`)
    return { problem: `has an unexpected shape: ${issues.join('; ')}` }
  }
  return { manifest: checked.data }
}
