import { subscriptionEnvironment } from './subscription.ts'

const HISTORY_LIMIT = 512 * 1024

export type NativeTerminalOptions = {
  readonly cwd: string
  readonly cols: number
  readonly rows: number
  readonly onData: (data: Uint8Array) => void
  readonly onExit: (code: number | null) => void
}

function validateDimensions(cols: number, rows: number) {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 1 ||
    rows < 1 ||
    cols > 500 ||
    rows > 300
  )
    throw new Error('Terminal dimensions must be integers within 1–500 columns and 1–300 rows')
}

/** The command override is for trusted host code and tests; never expose it through HTTP. */
export function startNativeTerminal(
  options: NativeTerminalOptions,
  internalOptions: { readonly command?: readonly string[] } = {},
) {
  validateDimensions(options.cols, options.rows)
  if (typeof Bun.Terminal !== 'function')
    throw new Error('Native terminal requires Bun 1.3.5 or newer with PTY support')
  if (process.platform !== 'darwin' && process.platform !== 'linux')
    throw new Error('Native terminal is currently supported on macOS and Linux')
  const command = [...(internalOptions.command ?? ['claude'])]
  const executable = command[0]
  if (!executable || !Bun.which(executable))
    throw new Error(
      'Claude Code executable not found. Install it and ensure it is available on PATH.',
    )
  let history = new Uint8Array(0)
  let closed = false
  let killTimer: ReturnType<typeof setTimeout> | undefined
  const terminal = new Bun.Terminal({
    cols: options.cols,
    rows: options.rows,
    data(_terminal, data) {
      const combined = new Uint8Array(history.length + data.length)
      combined.set(history)
      combined.set(data, history.length)
      let offset = Math.max(0, combined.length - HISTORY_LIMIT)
      // Avoid beginning replay in the middle of a multibyte UTF-8 code point.
      while (offset < combined.length && ((combined[offset] ?? 0) & 0xc0) === 0x80) offset++
      history = combined.slice(offset)
      options.onData(new Uint8Array(data))
    },
  })
  let processHandle: ReturnType<typeof Bun.spawn>
  try {
    // Native authentication, permission prompts, configuration and slash commands remain Claude's.
    processHandle = Bun.spawn(command, {
      cwd: options.cwd,
      terminal,
      env: subscriptionEnvironment(),
    })
  } catch (error) {
    terminal.close()
    throw new Error('Could not start the native Claude Code terminal', { cause: error })
  }
  const exited = processHandle.exited.then((code) => {
    closed = true
    clearTimeout(killTimer)
    terminal.close()
    options.onExit(code)
    return code
  })
  return {
    exited,
    write(data: string | Uint8Array) {
      if (closed) throw new Error('Native terminal is closed')
      terminal.write(data)
    },
    resize(cols: number, rows: number) {
      validateDimensions(cols, rows)
      if (closed) throw new Error('Native terminal is closed')
      terminal.resize(cols, rows)
    },
    history() {
      return history.slice()
    },
    close() {
      if (closed) return
      closed = true
      processHandle.kill('SIGTERM')
      terminal.close()
      killTimer = setTimeout(() => {
        if (processHandle.exitCode === null) processHandle.kill('SIGKILL')
      }, 1000)
      killTimer.unref()
    },
  }
}
