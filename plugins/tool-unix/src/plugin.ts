import { definePlugin } from '@aidcrew/plugin-sdk'
import { awkTool, lsofTool, wcTool } from './unix.ts'

export default definePlugin({
  name: 'tool-unix',
  tools: [wcTool, awkTool, lsofTool],
})
