import { definePlugin } from '@aidcrew/plugin-sdk'
import { gitLogTool } from './git-log.ts'

/** What happened to a path, from git, without the shell. */
export default definePlugin({
  name: 'tool-git',
  tools: [gitLogTool],
})
