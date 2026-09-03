import { definePlugin } from '@aidcrew/plugin-sdk'
import { jsonTool, tomlTool } from './data.ts'

/** One value out of a JSON or TOML file, by path. */
export default definePlugin({
  name: 'tool-data',
  tools: [jsonTool, tomlTool],
})
