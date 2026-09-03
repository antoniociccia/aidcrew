/**
 * The entry point, and only that.
 *
 * `main.ts` exports `run` rather than calling it under `import.meta.main`,
 * because a compiled binary on Windows answers that check false and then
 * does nothing at all. This file has no check to fail: importing it is
 * running it, which is the one property an entry point needs.
 */
import { run } from './main.ts'

await run()
