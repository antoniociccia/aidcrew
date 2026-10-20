import { afterEach, expect, test } from 'bun:test'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { browserSources } from './browser-sources.ts'

const directories: string[] = []
afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  )
})

test('bundles shared avatar code as both executable module and isolated browser source', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'aidcrew-browser-source-'))
  directories.push(directory)
  const source = resolve('packages/core/src/agent-avatar.ts')
  const entry = join(directory, 'entry.ts')
  await writeFile(
    entry,
    `import { agentAvatar } from ${JSON.stringify(source)}\nimport source from ${JSON.stringify(`${source}?browser-source`)} with { type: 'text' }\nexport const identity = agentAvatar('architect')\nexport const browserSource = source\n`,
  )
  const result = await Bun.build({ entrypoints: [entry], target: 'bun', plugins: [browserSources] })
  expect(result.success).toBe(true)
  const bundle = await result.outputs[0]?.text()
  expect(bundle).toContain('export function agentAvatar')
  expect(bundle).toContain('architect')
})
