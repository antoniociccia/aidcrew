import { timingSafeEqual } from 'node:crypto'
import { getNativeAgent } from '@aidcrew/agent-native'
import { definePlugin, defineUi } from '@aidcrew/plugin-sdk'
import xtermFit from '@xterm/addon-fit/lib/addon-fit.mjs' with { type: 'text' }
import xtermCss from '@xterm/xterm/css/xterm.css' with { type: 'text' }
import xterm from '@xterm/xterm/lib/xterm.mjs' with { type: 'text' }
import avatarSource from '../../../packages/core/src/agent-avatar.ts?browser-source' with {
  type: 'text',
}
import activityCss from './activity.css' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import activitySource from './activity.ts' with { type: 'text' }
// @ts-expect-error Bun embeds browser JavaScript as text.
import activityClient from './activity-client.js' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import activityTextSource from './activity-text.ts' with { type: 'text' }
import script from './client.js' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import pulseSource from './crew-pulse.ts' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import feedSource from './feed.ts' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import memoryGraphSource from './memory-graph.ts' with { type: 'text' }
// @ts-expect-error Bun embeds the browser JavaScript module as text.
import memoryClient from './memory-graph-client.js' with { type: 'text' }
import memoryInteractionsCss from './memory-interactions.css' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import memoryTextSource from './memory-text.ts' with { type: 'text' }
// @ts-expect-error Bun embeds the browser JavaScript module as text.
import nativeClient from './native-client.js' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import nativeProtocol from './native-protocol.ts' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import nativeText from './native-text.ts' with { type: 'text' }
import overviewCss from './overview.css' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import overviewSource from './overview.ts' with { type: 'text' }
// @ts-expect-error Bun embeds the browser JavaScript module as text.
import overviewClient from './overview-client.js' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import overviewTextSource from './overview-text.ts' with { type: 'text' }
import html from './page.html' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import paletteSource from './palette.ts' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import paletteTextSource from './palette-text.ts' with { type: 'text' }
import { actionSchema, type SessionBridge } from './protocol.ts'
import quickChatCss from './quick-chat.css' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import quickChatSource from './quick-chat.ts' with { type: 'text' }
// @ts-expect-error Bun embeds browser JavaScript as text.
import quickChatClient from './quick-chat-client.js' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import quickChatTextSource from './quick-chat-text.ts' with { type: 'text' }
import settingsCss from './settings.css' with { type: 'text' }
// @ts-expect-error Bun embeds the browser JavaScript module as text.
import settingsClient from './settings-client.js' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import settingsTextSource from './settings-text.ts' with { type: 'text' }
import css from './style.css' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import taskTextSource from './task-text.ts' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import tasksSource from './tasks.ts' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import teamGraphSource from './team-graph.ts' with { type: 'text' }
// @ts-expect-error Bun embeds the browser JavaScript module as text.
import teamClient from './team-graph-client.js' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import teamInteractionsSource from './team-interactions.ts' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import teamTextSource from './team-text.ts' with { type: 'text' }
import { type TerminalSocketData, terminalSockets } from './terminal-socket.ts'
import tilingCss from './tiling.css' with { type: 'text' }
// @ts-expect-error Bun embeds the browser JavaScript module as text.
import tilingClient from './tiling-client.js' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import tilingLayoutSource from './tiling-layout.ts' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import tilingTextSource from './tiling-text.ts' with { type: 'text' }
// @ts-expect-error TypeScript does not model Bun's text loader for TypeScript sources.
import textSource from './ui-text.ts' with { type: 'text' }
import workspaceCss from './workspace.css' with { type: 'text' }

const transpiler = new Bun.Transpiler({ loader: 'ts', target: 'browser' })
const browserStyles = new Map([
  ['/activity.css', activityCss],
  ['/quick-chat.css', quickChatCss],
  ['/settings.css', settingsCss],
  ['/memory-interactions.css', memoryInteractionsCss],
  ['/overview.css', overviewCss],
  ['/workspace.css', workspaceCss],
  ['/tiling.css', tilingCss],
])
const browserModules = new Map([
  ['/activity-client.js', activityClient],
  ['/activity.js', transpiler.transformSync(activitySource)],
  ['/activity-text.js', transpiler.transformSync(activityTextSource)],
  ['/quick-chat-client.js', quickChatClient],
  ['/quick-chat.js', transpiler.transformSync(quickChatSource)],
  ['/quick-chat-text.js', transpiler.transformSync(quickChatTextSource)],
  ['/settings-client.js', settingsClient],
  ['/settings-text.js', transpiler.transformSync(settingsTextSource)],
  ['/tiling-client.js', tilingClient],
  ['/tiling-layout.js', transpiler.transformSync(tilingLayoutSource)],
  ['/tiling-text.js', transpiler.transformSync(tilingTextSource)],
  ['/overview.js', transpiler.transformSync(overviewSource)],
  ['/overview-client.js', overviewClient],
  ['/overview-text.js', transpiler.transformSync(overviewTextSource)],
  ['/memory-graph-client.js', memoryClient],
  ['/memory-graph.js', transpiler.transformSync(memoryGraphSource)],
  ['/memory-text.js', transpiler.transformSync(memoryTextSource)],
  ['/agent-avatar.js', transpiler.transformSync(avatarSource)],
  ['/team-graph.js', transpiler.transformSync(teamGraphSource)],
  ['/team-text.js', transpiler.transformSync(teamTextSource)],
  ['/team-interactions.js', transpiler.transformSync(teamInteractionsSource)],
  ['/team-graph-client.js', teamClient],
  ['/xterm.js', xterm],
  ['/xterm-fit.js', xtermFit],
  ['/native-client.js', nativeClient],
  ['/native-protocol.js', transpiler.transformSync(nativeProtocol)],
  ['/native-text.js', transpiler.transformSync(nativeText)],
  ['/tasks.js', transpiler.transformSync(tasksSource)],
  ['/task-text.js', transpiler.transformSync(taskTextSource)],
  [
    '/palette.js',
    transpiler.transformSync(paletteSource).replace('./palette-text.ts', './palette-text.js'),
  ],
  ['/palette-text.js', transpiler.transformSync(paletteTextSource)],
  ['/crew-pulse.js', transpiler.transformSync(pulseSource)],
  ['/feed.js', transpiler.transformSync(feedSource)],
  ['/ui-text.js', transpiler.transformSync(textSource)],
])

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
    // xterm generates font and geometry styles; scripts remain same-origin only.
    'Content-Security-Policy':
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  }
  const json = (data: unknown, status = 200) => Response.json(data, { status, headers })
  const terminals = terminalSockets({
    snapshot: () => bridge.snapshot(),
    matches,
    resolve: getNativeAgent,
    stop: (agent) => bridge.dispatch({ type: 'cancel', agent }),
  })
  const server = Bun.serve<TerminalSocketData>({
    hostname: '127.0.0.1',
    port: options.port ?? 4318,
    maxRequestBodySize: 120_000,
    websocket: terminals.websocket,
    async fetch(request, server) {
      const url = new URL(request.url)
      // Only a configured proxy host is trusted; forwarded headers cannot opt in.
      const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      if (!local && url.host !== remote?.host) return json({ error: 'Invalid host' }, 403)
      const origin = request.headers.get('Origin')
      if (origin && origin !== remote?.origin && (!local || origin !== url.origin))
        return json({ error: 'Invalid origin' }, 403)
      const path = url.pathname
      if (request.method === 'GET' && browserStyles.has(path))
        return new Response(browserStyles.get(path), {
          headers: { ...headers, 'Content-Type': 'text/css; charset=utf-8' },
        })
      if (path === '/api/terminal') {
        if (request.method !== 'GET' || url.search)
          return json({ error: 'Invalid terminal request' }, 400)
        return server.upgrade(request, { data: { authenticated: false } })
          ? undefined
          : json({ error: 'WebSocket required' }, 400)
      }
      if (path === '/xterm.css' && request.method === 'GET')
        return new Response(xtermCss, { headers: { ...headers, 'Content-Type': 'text/css' } })
      const browserModule = browserModules.get(path)
      if (request.method === 'GET' && browserModule)
        return new Response(browserModule, {
          headers: { ...headers, 'Content-Type': 'text/javascript; charset=utf-8' },
        })
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
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="12" fill="#56b4e9"/><text x="32" y="44" font-family="ui-monospace,Menlo,monospace" font-size="36" font-weight="700" text-anchor="middle" fill="#0e0f15">D</text></svg>',
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
    close: () => {
      terminals.close()
      server.stop(true)
    },
  }
}
