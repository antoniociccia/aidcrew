import { plugin } from 'bun'
import { widthOf } from './index.ts'

/**
 * Hands Ink our width function in place of the one it asks for.
 *
 * Ink calls `string-width` to lay out every row of every frame. The published
 * implementation segments each string into graphemes and runs several Unicode
 * property regexes over it — correct, and about 650µs for any string holding a
 * single non-ASCII character. An em dash is enough. A screen of ordinary prose
 * took ninety milliseconds to draw where the same screen in ASCII took under
 * one, so scrolling through a long conversation was unusable.
 *
 * Redirecting the module rather than patching the package: a patch has to be
 * reapplied after every install and silently stops existing when it is not,
 * and this is a decision about how our program runs rather than a change to
 * somebody else's code.
 *
 * The two agree. `width.test.ts` checks ours against the published one on
 * emoji, joined emoji, combining marks, full-width characters, flags and box
 * drawing, so the substitution is a substitution and not an approximation.
 */
plugin({
  name: 'aidcrew:fast-width',
  setup(build) {
    build.module('string-width', () => ({
      exports: { default: widthOf },
      loader: 'object',
    }))
  },
})
