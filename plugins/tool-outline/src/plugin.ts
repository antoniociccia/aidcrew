import { definePlugin } from '@aidcrew/plugin-sdk'
import { depsTool } from './deps.ts'
import { importsTool } from './imports.ts'
import { outlineTool } from './outline.ts'
import { symbolsTool } from './symbols.ts'

/** What a file declares, what it imports, where a name is defined, what a package needs. */
export default definePlugin({
  name: 'tool-outline',
  tools: [outlineTool, symbolsTool, importsTool, depsTool],
})
