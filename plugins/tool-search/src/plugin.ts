import { definePlugin } from '@aidcrew/plugin-sdk'
import { globTool, grepTool } from './search.ts'

export default definePlugin({
  name: 'tool-search',
  tools: [grepTool, globTool],
})
