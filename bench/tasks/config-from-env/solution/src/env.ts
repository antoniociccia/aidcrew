import type { Config } from './config.ts'

const TRUE = new Set(['true', '1', 'yes'])
const FALSE = new Set(['false', '0', 'no'])

/** The configuration the environment carries, typed; absent and empty variables are left out. */
export function fromEnv(env: Record<string, string | undefined>, prefix = 'APP_'): Partial<Config> {
  const out: Partial<Config> = {}
  const read = (name: string): string | undefined => {
    const value = env[`${prefix}${name}`]
    return value === undefined || value === '' ? undefined : value
  }

  const port = read('PORT')
  if (port !== undefined) {
    const number = Number(port)
    if (!Number.isFinite(number)) throw new TypeError(`${prefix}PORT is not a number: ${port}`)
    out.port = number
  }
  const host = read('HOST')
  if (host !== undefined) out.host = host
  const debug = read('DEBUG')
  if (debug !== undefined) {
    const word = debug.toLowerCase()
    if (TRUE.has(word)) out.debug = true
    else if (FALSE.has(word)) out.debug = false
    else throw new TypeError(`${prefix}DEBUG is neither true nor false: ${debug}`)
  }
  const name = read('NAME')
  if (name !== undefined) out.name = name
  return out
}
