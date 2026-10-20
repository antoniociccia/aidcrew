import { STOP } from './mouse.ts'

type NativeSession = {
  readonly closed: boolean
  history(): Uint8Array
  write(data: string): void
  resize(cols: number, rows: number): void
  subscribe(listener: { data(data: Uint8Array): void; exit(code: number | null): void }): () => void
}

/** Attaches to the existing agent process; detaching leaves its work running. */
export async function attachNativeTerminal(
  session: NativeSession,
  keyboard: { pause(): void; resume(): void },
  input: NodeJS.ReadStream = process.stdin,
  output: NodeJS.WriteStream = process.stdout,
): Promise<void> {
  if (session.closed) throw new Error('Native agent session is closed')
  keyboard.pause()
  let unsubscribe = () => {}
  let read = (_chunk: string | Buffer): void => {}
  let resize = (): void => {}
  try {
    output.write(`${STOP}\u001b[?1049l\u001b[?25h`)
    input.setRawMode(true)
    await new Promise<void>((resolve, reject) => {
      read = (chunk) => {
        const text = String(chunk)
        const detach = text.indexOf('\u001d')
        try {
          const forwarded = detach < 0 ? text : text.slice(0, detach)
          if (forwarded) session.write(forwarded)
          if (detach >= 0) resolve()
        } catch (error) {
          reject(error)
        }
      }
      resize = () => {
        try {
          session.resize(
            Math.max(1, Math.min(500, output.columns || 80)),
            Math.max(1, Math.min(300, output.rows || 24)),
          )
        } catch (error) {
          reject(error)
        }
      }
      output.write(session.history())
      unsubscribe = session.subscribe({
        data: (data) => {
          output.write(data)
        },
        exit: () => resolve(),
      })
      resize()
      input.on('data', read)
      output.on('resize', resize)
      input.resume()
    })
  } finally {
    input.off('data', read)
    output.off('resize', resize)
    unsubscribe()
    input.pause()
    input.setRawMode(false)
    output.write(`${STOP}\u001b[?1049h\u001b[2J\u001b[H\u001b[?25l`)
    keyboard.resume()
  }
}
