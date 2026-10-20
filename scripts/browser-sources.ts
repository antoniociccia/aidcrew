import { resolve } from 'node:path'
import type { BunPlugin } from 'bun'

/** Bun otherwise deduplicates text and executable imports of the same shared module. */
export const browserSources: BunPlugin = {
  name: 'aidcrew:browser-sources',
  setup(build) {
    build.onResolve({ filter: /\?browser-source$/ }, (args) => ({
      path: `browser-text:${resolve(args.resolveDir, args.path.replace(/\?browser-source$/, ''))}`,
      namespace: 'aidcrew-browser-source',
    }))
    build.onLoad({ filter: /.*/, namespace: 'aidcrew-browser-source' }, async (args) => ({
      contents: await Bun.file(args.path.slice('browser-text:'.length)).text(),
      loader: 'text',
    }))
  },
}
