import { timingSafeEqual } from 'node:crypto'
import { definePlugin, defineUi } from '@aidcrew/plugin-sdk'
import script from './client.js' with { type: 'text' }
import html from './page.html' with { type: 'text' }
import { actionSchema, type SessionBridge } from './protocol.ts'
import css from './style.css' with { type: 'text' }

export type { SessionBridge, WebAction, WebState } from './protocol.ts'

export function startWebUI(
  bridge: SessionBridge,
  options: { port?: number; token?: string; remoteOrigin?: string | undefined } = {},
) {
  const remote = options.remoteOrigin ? new URL(options.remoteOrigin) : undefined
  if (
    remote &&
    (remote.protocol !== 'https:' ||
      remote.username ||
      remote.password ||
      remote.pathname !== '/' ||
      remote.search ||
      remote.hash ||
      remote.hostname.includes('*'))
  ) {
    throw new Error(
      'Remote origin must be an exact HTTPS origin without credentials, path, query or fragment',
    )
  }
  const token = options.token ?? crypto.randomUUID() + crypto.randomUUID()
  if (token.length < 32) throw new Error('Web access token must contain at least 32 characters')
  const matches = (given: string) => {
    const a = Buffer.from(given)
    const b = Buffer.from(token)
    return a.length === b.length && timingSafeEqual(a, b)
  }
  const headers = {
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  }
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers })
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: options.port ?? 4318,
    maxRequestBodySize: 120_000,
    async fetch(request) {
      const url = new URL(request.url)
      // Only a configured proxy host is trusted; forwarded headers cannot opt in.
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      if (!local && url.host !== remote?.host) return json({ error: 'Invalid host' }, 403)
      const origin = request.headers.get('Origin')
      if (origin && origin !== remote?.origin && (!local || origin !== url.origin))
        return json({ error: 'Invalid origin' }, 403)
      const path = url.pathname
      if (request.method === 'GET' && path === '/manifest.webmanifest') {
        return new Response(
          JSON.stringify({
            name: 'AIDCrew',
            short_name: 'AIDCrew',
            start_url: '/',
            scope: '/',
            display: 'standalone',
            background_color: '#0b1115',
            theme_color: '#0b1115',
            icons: [{ src: '/app-icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
          }),
          { headers: { ...headers, 'Content-Type': 'application/manifest+json' } },
        )
      }
      if (request.method === 'GET' && path === '/app-icon.svg') {
        return new Response(
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 192 192"><rect width="192" height="192" rx="40" fill="#0b1115"/><rect x="35" y="35" width="122" height="122" rx="12" fill="#b7f4cf"/><path d="M69 62h24c29 0 40 15 40 34s-11 34-40 34H69Zm18 16v36h6c15 0 22-6 22-18s-7-18-22-18Z" fill="#0b1115"/></svg>',
          { headers: { ...headers, 'Content-Type': 'image/svg+xml' } },
        )
      }
      if (request.method === 'GET' && ['/', '/style.css', '/client.js'].includes(path)) {
        const [body, type] =
          path === '/'
            ? [html as unknown as string, 'text/html']
            : path === '/style.css'
              ? [css, 'text/css']
              : [script, 'text/javascript']
        return new Response(body, {
          headers: { ...headers, 'Content-Type': `${type}; charset=utf-8` },
        })
      }
      if (!matches(request.headers.get('Authorization')?.replace(/^Bearer /, '') ?? ''))
        return json({ error: 'Authentication required' }, 401)
      try {
        if (path === '/api/state' && request.method === 'GET') {
          const body = JSON.stringify(bridge.snapshot())
          const etag = `"${Bun.hash(body).toString(16)}"`
          if (request.headers.get('If-None-Match') === etag)
            return new Response(null, { status: 304, headers: { ...headers, ETag: etag } })
          return new Response(body, {
            headers: { ...headers, ETag: etag, 'Content-Type': 'application/json' },
          })
        }
        if (path === '/api/action' && request.method === 'POST') {
          if (!request.headers.get('Content-Type')?.startsWith('application/json'))
            return json({ error: 'Expected JSON' }, 415)
          const parsed = actionSchema.safeParse(await request.json())
          if (!parsed.success) return json({ error: 'Invalid action' }, 400)
          if (request.headers.get('X-AIDCrew-Session') !== bridge.snapshot().sessionId)
            return json(
              { error: 'The workspace changed. Wait for synchronization before trying again.' },
              409,
            )
          const result = await bridge.dispatch(parsed.data)
          return json({ result: result ?? null })
        }
        return json({ error: 'Not found' }, 404)
      } catch (error) {
        return json({ error: error instanceof Error ? error.message : 'Request failed' }, 400)
      }
    },
  })
  const address = `http://127.0.0.1:${server.port}`
  return {
    address,
    remoteUrl: remote ? `${remote.origin}/#${token}` : undefined,
    url: `${address}/#${token}`,
    plugin: definePlugin({
      name: 'web-ui',
      version: '0.1.0',
      ui: defineUi({
        slots: ['tray'],
        render: ({ theme }) => [
          { text: ` web :${server.port} `, color: theme.accent ?? '#b7f4cf' },
        ],
      }),
    }),
    close: () => server.stop(true),
  }
}
