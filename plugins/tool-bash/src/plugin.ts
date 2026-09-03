import { definePlugin } from '@aidcrew/plugin-sdk'
import { bashTool } from './bash.ts'

export default definePlugin({
  name: 'tool-bash',
  tools: [bashTool],
})
