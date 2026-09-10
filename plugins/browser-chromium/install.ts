#!/usr/bin/env bun
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const pluginRoot = dirname(fileURLToPath(import.meta.url))
const project = resolve(process.argv[2] ?? '.')
const destination = join(project, '.aidcrew/plugins/browser-chromium')
const mcpEntry = join(
  pluginRoot,
  'mcp/node_modules/chrome-devtools-mcp/build/src/bin/chrome-devtools-mcp.js',
)
if (!(await Bun.file(mcpEntry).exists()))
  throw new Error(`First run: npm ci --prefix ${join(pluginRoot, 'mcp')}`)
await mkdir(destination, { recursive: true })
const build = await Bun.build({
  entrypoints: [join(pluginRoot, 'src/index.ts')],
  target: 'bun',
  format: 'esm',
  external: ['@aidcrew/core', '@aidcrew/plugin-sdk', 'zod'],
  outdir: destination,
})
if (!build.success) throw new Error(build.logs.map(String).join('\n'))
await copyFile(join(pluginRoot, 'runtime.py'), join(destination, 'runtime.py'))
await copyFile(join(pluginRoot, 'watch-preview.ts'), join(destination, 'watch-preview.ts'))
await copyFile(join(pluginRoot, 'README.md'), join(destination, 'README.md'))
const configPath = join(project, '.aidcrew/config.toml')
let config = await readFile(configPath, 'utf8').catch(() => '')
const marker = '# Managed browser-chromium configuration'
const section = `${marker}\n[plugins.browser-chromium]\ncommand = "node"\nargs = [${JSON.stringify(mcpEntry)}]\nbrowserUrl = "http://127.0.0.1:9222"\n# End browser-chromium configuration\n`
if (config.includes(marker))
  config = config.replace(
    /# Managed browser-chromium configuration[\s\S]*?# End browser-chromium configuration\n?/,
    section,
  )
else if (config.includes('[plugins.browser-chromium]'))
  throw new Error(
    'Existing browser-chromium settings: configure command/args manually; plugin files were installed.',
  )
else config += `\n${section}`
await writeFile(configPath, config)
console.log(
  `Installed browser-chromium in ${destination}. Next: aidcrew plugin trust browser-chromium -C ${project}`,
)
