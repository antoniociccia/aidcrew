/**
 * What build this is.
 *
 * Stamped in at compile time for a released binary, and read from the package
 * when running from a checkout. A version that lies is worse than none: it is
 * the first thing a bug report is asked for, and the whole point of asking is
 * to know which code was running.
 */
import pkg from '../package.json' with { type: 'json' }

export const VERSION: string = process.env.AIDCREW_VERSION ?? (pkg as { version: string }).version
