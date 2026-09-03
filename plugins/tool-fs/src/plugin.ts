import { definePlugin } from '@aidcrew/plugin-sdk'
import { editTool, readTool, writeTool } from './tools.ts'

export default definePlugin({
  name: 'tool-fs',
  tools: [readTool, writeTool, editTool],
})
