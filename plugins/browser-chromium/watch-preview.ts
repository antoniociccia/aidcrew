/** Refresh only this local preview when its server comes online. No model call. */
type Page = { type: string; url: string; webSocketDebuggerUrl?: string }

export function isPreviewPage(page: Page, appUrl: string): boolean {
  try {
    const actual = new URL(page.url)
    const expected = new URL(appUrl)
    return (
      page.type === 'page' &&
      actual.protocol === expected.protocol &&
      ['localhost', '127.0.0.1', '[::1]'].includes(actual.hostname) &&
      actual.port === expected.port
    )
  } catch {
    return false
  }
}

async function navigate(page: Page): Promise<void> {
  if (!page.webSocketDebuggerUrl) throw new Error('Preview tab has no debugger connection')
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(page.webSocketDebuggerUrl!)
    const timer = setTimeout(() => finish(new Error('Preview navigation timed out')), 5000)
    function finish(error?: Error) {
      clearTimeout(timer)
      socket.close()
      if (error) reject(error)
      else resolve()
    }
    socket.onopen = () =>
      socket.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: page.url } }))
    socket.onerror = () => finish(new Error('Preview debugger connection failed'))
    socket.onmessage = (event) => {
      const result = JSON.parse(String(event.data))
      if (result.id === 1)
        finish(
          result.error || result.result?.errorText
            ? new Error('Preview navigation failed')
            : undefined,
        )
    }
  })
}

export async function refreshPreview(
  pages: Page[],
  appUrl: string,
  go: (page: Page) => Promise<void> = navigate,
): Promise<boolean> {
  const matches = pages.filter((page) => isPreviewPage(page, appUrl))
  if (!matches.length) return false
  const results = await Promise.allSettled(matches.map(go))
  return results.every((result) => result.status === 'fulfilled')
}

if (import.meta.main) {
  const appUrl = process.argv[2] ?? 'http://localhost:8787/'
  const debugUrl = process.argv[3] ?? 'http://127.0.0.1:9222'
  let online = false,
    failures = 0,
    attempts = 0
  for (;;) {
    const healthy = await fetch(appUrl, { signal: AbortSignal.timeout(1500) })
      .then(async (response) => {
        await response.body?.cancel()
        return response.ok
      })
      .catch(() => false)
    if (!healthy) {
      if (++failures >= 2) {
        online = false
        attempts = 0
      }
    } else {
      failures = 0
      if (!online && attempts < 3) {
        attempts++
        try {
          const response = await fetch(`${debugUrl}/json/list`, {
            signal: AbortSignal.timeout(1500),
          })
          if (!response.ok) throw new Error('Chromium unavailable')
          online = await refreshPreview((await response.json()) as Page[], appUrl)
          if (online)
            console.log(`${new Date().toISOString()} refreshed preview after server became ready`)
        } catch {
          console.error('Could not refresh preview; bounded retry pending')
        }
      }
    }
    await Bun.sleep(1000)
  }
}
