import { definePlugin } from '@aidcrew/plugin-sdk'
import { statTool } from './stat.ts'

/** What a path is — size, lines, text or binary, last change — before reading it. */
export default definePlugin({
  name: 'tool-stat',
  tools: [statTool],
})
