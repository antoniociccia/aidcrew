import { afterEach, expect, test } from 'bun:test'
import { startWebUI } from './index.ts'
import type { WebAction, WebState } from './protocol.ts'

const state: WebState = {
  sessionId: 'test-session',
  cwd: '/project',
  ready: true,
  agents: [],
  lines: [],
  target: '',
  sharedMemory: true,
  outstanding: 0,
  plugins: [],
  themes: [],
}
const servers: ReturnType<typeof startWebUI>[] = []
afterEach(() => {
  for (const server of servers.splice(0)) server.close()
})
function start(dispatch: (action: WebAction) => Promise<unknown> = async () => null) {
  const server = startWebUI({ snapshot: () => state, dispatch }, { port: 0 })
  servers.push(server)
  const headers = {
    Authorization: `Bearer ${server.url.split('#')[1]}`,
    'Content-Type': 'application/json',
    'X-AIDCrew-Session': 'test-session',
  }
  return { ...server, headers }
}
test('assets contain no token; session data requires authentication and responses are never cached', async () => {
  const server = start()
  const shell = await fetch(server.address)
  expect(shell.headers.get('Content-Security-Policy')).toContain("frame-ancestors 'none'")
  const html = await shell.text()
  expect(html).toContain('Your crew, in motion.')
  expect(html).not.toContain(server.url.split('#')[1] ?? 'missing token')
  expect((await fetch(`${server.address}/api/state`)).status).toBe(401)
  const response = await fetch(`${server.address}/api/state`, { headers: server.headers })
  expect(response.headers.get('Cache-Control')).toBe('no-store')
  expect(await response.json()).toEqual(state)
  expect((await fetch(`${server.address}/client.js`)).headers.get('Content-Type')).toContain(
    'javascript',
  )
})
test('rejects cross-origin commands, invalid input and forged hosts before dispatch', async () => {
  const actions: WebAction[] = []
  const server = start(async (action) => {
    actions.push(action)
  })
  const action: WebAction = { type: 'send', agent: 'coder', text: 'build' }
  for (const origin of ['https://malicious.example', 'null']) {
    const response = await fetch(`${server.address}/api/action`, {
      method: 'POST',
      headers: { ...server.headers, Origin: origin },
      body: JSON.stringify(action),
    })
    expect(response.status).toBe(403)
  }
  expect(
    (
      await fetch(`${server.address}/api/state`, {
        headers: { ...server.headers, Host: 'evil.example' },
      })
    ).status,
  ).toBe(403)
  expect(
    (
      await fetch(`${server.address}/api/action`, {
        method: 'POST',
        headers: server.headers,
        body: JSON.stringify({ type: 'yolo', agent: 'coder', on: 'yes' }),
      })
    ).status,
  ).toBe(400)
  expect(actions).toEqual([])
  expect(
    (
      await fetch(`${server.address}/api/action`, {
        method: 'POST',
        headers: { ...server.headers, Origin: server.address },
        body: JSON.stringify(action),
      })
    ).status,
  ).toBe(200)
  expect(actions).toEqual([action])
})
test('two clients dispatch into the same bridge and see the same updated state', async () => {
  const previous = [...state.lines]
  try {
    const server = start(async (action) => {
      if (action.type === 'send')
        state.lines.push({ agentId: action.agent, kind: 'ask', text: action.text })
    })
    await fetch(`${server.address}/api/action`, {
      method: 'POST',
      headers: server.headers,
      body: JSON.stringify({ type: 'send', agent: 'coder', text: 'one session' }),
    })
    const result = await fetch(`${server.address}/api/state`, { headers: server.headers }).then(
      (r) => r.json(),
    )
    expect((result as WebState).lines.at(-1)?.text).toBe('one session')
  } finally {
    state.lines = previous
  }
})

test('unchanged snapshots return an ETag without repeatedly transferring the journal', async () => {
  const server = start()
  const first = await fetch(`${server.address}/api/state`, { headers: server.headers })
  const etag = first.headers.get('ETag')
  expect(etag).toBeTruthy()
  const unchanged = await fetch(`${server.address}/api/state`, {
    headers: { ...server.headers, 'If-None-Match': etag ?? '' },
  })
  expect(unchanged.status).toBe(304)
  expect(await unchanged.text()).toBe('')
})

test('an old browser view cannot send a command into a different workspace', async () => {
  let dispatched = false
  const server = start(async () => {
    dispatched = true
  })
  const response = await fetch(`${server.address}/api/action`, {
    method: 'POST',
    headers: { ...server.headers, 'X-AIDCrew-Session': 'previous-session' },
    body: JSON.stringify({ type: 'send', agent: 'coder', text: 'Wrong project' }),
  })
  expect(response.status).toBe(409)
  expect(dispatched).toBe(false)
})

test('web wordmark uses the terminal spelling and filled D instead of an unrelated icon', async () => {
  const { wordmarkText } = await import('../../../packages/tui/src/logo.ts')
  const server = start()
  const html = await (await fetch(server.address)).text()
  const mark = html.match(/<a[^>]*class="wordmark"[^>]*>(.*?)<\/a>/s)?.[1]
  expect(mark?.replace(/<[^>]+>/g, '')).toBe(wordmarkText())
  expect(mark).toContain('class="wordmark-d"')
  expect(html).not.toContain('A<span>↗</span>')
})

test('offers a single agent selector and a collapsed, explicitly controlled workspace sidebar', async () => {
  const server = start()
  const html = await (await fetch(server.address)).text()
  expect(html).not.toContain('id="roster"')
  expect(html).toContain('aria-label="Select agent"')
  expect(html).toContain('id="sidebar" hidden')
  expect(html).toContain('aria-controls="sidebar" aria-expanded="false"')
})
