import { definePlugin } from '@aidcrew/plugin-sdk'
import { headTool } from './head.ts'

/** The beginning or the end of a file, without reading the whole of it. */
export default definePlugin({
  name: 'tool-head',
  tools: [headTool],
})
