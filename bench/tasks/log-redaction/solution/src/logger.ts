import { redact } from './redact.ts'

export type Fields = Record<string, unknown>

/** One JSON line per call: level, message, fields, in that order. */
export function log(
  level: 'info' | 'warn' | 'error',
  message: string,
  fields: Fields = {},
): string {
  return `${JSON.stringify({ level, message, ...(redact(fields) as Fields) })}\n`
}
