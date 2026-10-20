import { Terminal } from '/xterm.js'
import { FitAddon } from '/xterm-fit.js'
import { parseTerminalMessage, terminalSize } from './native-protocol.js'
import { nativeText } from './native-text.js'

/** Opening is explicit; detaching never sends a stop to the native process. */
export function initNativeTerminal({ container, token, session, agent, onError }) {
  let terminal, fit, socket, observer, input, frame
  let ready = false
  let generation = 0
  let destroyed = false
  const status = document.createElement('p')
  status.className = 'quiet small native-status'
  status.setAttribute('role', 'status')
  const screen = document.createElement('div')
  screen.className = 'native-screen'
  screen.setAttribute('aria-label', nativeText.label)
  container.append(status, screen)

  function send(message) {
    if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(message))
  }
  function resize() {
    if (!terminal || !fit || !screen.clientWidth || !screen.clientHeight) return
    try {
      fit.fit()
      if (ready) send({ type: 'resize', ...terminalSize(terminal.cols, terminal.rows) })
    } catch {
      onError(nativeText.outputUnavailable)
    }
  }
  function close() {
    generation++
    ready = false
    if (frame !== undefined) cancelAnimationFrame(frame)
    frame = undefined
    observer?.disconnect()
    observer = undefined
    input?.dispose()
    input = undefined
    socket?.close()
    socket = undefined
    terminal?.dispose()
    terminal = undefined
    fit = undefined
    screen.replaceChildren()
    status.textContent = nativeText.disconnected
  }
  function open() {
    if (destroyed) return
    close()
    const accessToken = token()
    const sessionId = session()
    const agentId = agent()
    if (!accessToken || !sessionId || !agentId) {
      onError(nativeText.authenticationRequired)
      return
    }
    const current = generation
    status.textContent = nativeText.connecting
    terminal = new Terminal({
      cursorBlink: true,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      scrollback: 5000,
      theme: { background: '#0b0e13', foreground: '#e7edf3' },
    })
    fit = new FitAddon()
    terminal.loadAddon(fit)
    terminal.open(screen)
    resize()
    const url = new URL('/api/terminal', location.href)
    url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:'
    const connection = new WebSocket(url)
    socket = connection
    connection.onopen = () => {
      if (current !== generation) return
      send({ type: 'auth', token: accessToken, sessionId, agentId, ...terminalSize(terminal.cols, terminal.rows) })
    }
    connection.onmessage = (event) => {
      if (current !== generation) return
      const message = typeof event.data === 'string' ? parseTerminalMessage(event.data) : undefined
      if (!message) {
        onError(nativeText.invalidFrame)
        close()
        return
      }
      if (message.type === 'ready') {
        ready = true
        status.textContent = nativeText.connected
        resize()
        terminal.focus()
      } else if (message.type === 'output') {
        terminal.write(message.data)
      } else if (message.type === 'exit') {
        ready = false
        status.textContent = nativeText.stopped(message.code)
      } else {
        ready = false
        status.textContent = message.message
        onError(message.message)
      }
    }
    connection.onerror = () => {
      if (current !== generation) return
      ready = false
      status.textContent = nativeText.connectionError
      onError(nativeText.connectionError)
    }
    connection.onclose = () => {
      if (current !== generation) return
      ready = false
      if (status.textContent === nativeText.connected || status.textContent === nativeText.connecting)
        status.textContent = nativeText.disconnected
    }
    input = terminal.onData((data) => {
      if (ready) send({ type: 'input', data })
    })
    observer = new ResizeObserver(() => {
      if (frame !== undefined) cancelAnimationFrame(frame)
      frame = requestAnimationFrame(resize)
    })
    observer.observe(screen)
  }
  return {
    open,
    close,
    stop() {
      if (ready) send({ type: 'stop' })
    },
    destroy() {
      close()
      destroyed = true
      status.remove()
      screen.remove()
    },
  }
}
