import { definePlugin } from '@aidcrew/plugin-sdk'
import { treeTool } from './tree.ts'

/** The shape of a directory, bounded and gitignore-aware. */
export default definePlugin({
  name: 'tool-tree',
  tools: [treeTool],
})
