import { definePlugin } from '@aidcrew/plugin-sdk'
import { claudeLoader } from './loader.ts'

export default definePlugin({
  name: 'loader-claude',
  loaders: [claudeLoader],
})
