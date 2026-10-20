type TerminalMessage =
  | { type: 'ready' }
  | { type: 'output'; data: string }
  | { type: 'exit'; code: number | null }
  | { type: 'error'; message: string }

/** Reject mismatched local protocol versions before passing bytes to the emulator. */
export function parseTerminalMessage(raw: string): TerminalMessage | undefined {
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return undefined
  }
  if (typeof value !== 'object' || value === null || !('type' in value)) return undefined
  if (value.type === 'ready') return { type: 'ready' }
  if (value.type === 'output' && 'data' in value && typeof value.data === 'string')
    return { type: 'output', data: value.data }
  if (
    value.type === 'exit' &&
    'code' in value &&
    (value.code === null || (typeof value.code === 'number' && Number.isInteger(value.code)))
  )
    return { type: 'exit', code: value.code }
  if (value.type === 'error' && 'message' in value && typeof value.message === 'string')
    return { type: 'error', message: value.message }
  return undefined
}

export function terminalSize(cols: number, rows: number) {
  return {
    cols: Number.isFinite(cols) ? Math.max(2, Math.min(500, Math.floor(cols))) : 80,
    rows: Number.isFinite(rows) ? Math.max(1, Math.min(300, Math.floor(rows))) : 24,
  }
}
