// The viewer's server: a page and a small read-only API over one store, on
// loopback only. Everything an agent wrote is model output, so it leaves here
// as JSON data and the page only ever puts it on screen as text.
import { z } from 'zod'
import type { RunStore } from '../contracts.ts'
import { checkEscape } from '../eval/escape.ts'
import { generateWorld } from '../world/generate.ts'
import { createFrameCursor, framesOf } from './frames.ts'

export interface ViewerOptions {
  store: RunStore
  /** 0 picks a free port. */
  port?: number
  /** How often a live stream looks for new ticks. */
  pollMs?: number
}

export interface Viewer {
  url: string
  stop(): void
}

const SECURITY_HEADERS = {
  'content-security-policy':
    "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'",
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'cache-control': 'no-store',
}

const STATIC: Record<string, { file: string; type: string }> = {
  '/': { file: 'page.html', type: 'text/html; charset=utf-8' },
  '/page.js': { file: 'page.js', type: 'text/javascript; charset=utf-8' },
  '/page.css': { file: 'page.css', type: 'text/css; charset=utf-8' },
}

const RunId = z.string().regex(/^[A-Za-z0-9-]{1,64}$/)
const Range = z.object({
  from: z.coerce.number().int().min(0).max(1_000_000).optional(),
  to: z.coerce.number().int().min(0).max(1_000_000).optional(),
})

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...SECURITY_HEADERS, 'content-type': 'application/json; charset=utf-8' },
  })
const problem = (status: number, error: string) => json({ error }, status)

async function describeRun(store: RunStore, runId: string): Promise<Response> {
  const run = store.run(runId)
  if (!run) return problem(404, 'no such run')
  const world = generateWorld(run.config.seed, run.config.agents)
  return json({
    runId,
    config: run.config,
    status: run.status,
    report: await checkEscape(store, runId),
    world: { width: world.width, height: world.height, terrain: world.terrain },
    // The human's view only: no agent ever sees this.
    observer: { fertile: world.rules.fertile, rules: world.rules },
  })
}

function stream(store: RunStore, runId: string, pollMs: number): Response {
  const cursor = createFrameCursor(store, runId)
  const encoder = new TextEncoder()
  let timer: ReturnType<typeof setInterval> | undefined
  let status = ''
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (event: string, data: unknown) =>
        controller.enqueue(encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`))
      const poll = () => {
        try {
          for (const frame of cursor.advance()) send('frame', frame)
          const now = store.run(runId)?.status ?? 'missing'
          if (now !== status) {
            status = now
            send('status', { status })
          }
        } catch (err) {
          // The page reconnects on its own; tell it why this stream ended.
          send('error', { error: err instanceof Error ? err.message : String(err) })
          clearInterval(timer)
          controller.close()
        }
      }
      controller.enqueue(encoder.encode(': connected\n\n'))
      poll()
      timer = setInterval(poll, pollMs)
    },
    cancel() {
      clearInterval(timer)
    },
  })
  return new Response(body, {
    headers: {
      ...SECURITY_HEADERS,
      'content-type': 'text/event-stream; charset=utf-8',
      connection: 'keep-alive',
    },
  })
}

async function route(req: Request, store: RunStore, pollMs: number): Promise<Response> {
  if (req.method !== 'GET') return problem(405, 'read only')
  const url = new URL(req.url)
  const asset = STATIC[url.pathname]
  if (asset) {
    const file = Bun.file(new URL(asset.file, import.meta.url))
    return new Response(file, { headers: { ...SECURITY_HEADERS, 'content-type': asset.type } })
  }
  if (url.pathname === '/api/runs') {
    return json(
      store.runs().map((r) => ({
        runId: r.runId,
        status: r.status,
        createdAt: r.createdAt,
        decider: r.config.decider,
        condition: r.config.condition,
        seed: r.config.seed,
        ticks: r.config.ticks,
        agents: r.config.agents,
      })),
    )
  }
  const match = /^\/api\/runs\/([^/]+)(?:\/(frames|stream))?$/.exec(url.pathname)
  if (!match) return problem(404, 'not found')
  const id = RunId.safeParse(decodeURIComponent(match[1] ?? ''))
  if (!id.success) return problem(400, 'bad run id')
  const range = Range.safeParse(Object.fromEntries(url.searchParams))
  if (!range.success) return problem(400, 'bad range')
  if (!store.run(id.data)) return problem(404, 'no such run')
  switch (match[2]) {
    case 'frames': {
      const { from, to } = range.data
      return json(
        framesOf(store, id.data, {
          ...(from === undefined ? {} : { from }),
          ...(to === undefined ? {} : { to }),
        }),
      )
    }
    case 'stream':
      return stream(store, id.data, pollMs)
    default:
      return describeRun(store, id.data)
  }
}

export function startViewer(opts: ViewerOptions): Viewer {
  const pollMs = opts.pollMs ?? 500
  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: opts.port ?? 4747,
    // A live stream is quiet between ticks; the default idle limit would cut it.
    idleTimeout: 0,
    async fetch(req) {
      try {
        return await route(req, opts.store, pollMs)
      } catch (err) {
        console.error(`viewer: ${req.method} ${new URL(req.url).pathname}:`, err)
        return problem(500, 'internal error')
      }
    },
  })
  return {
    url: `http://127.0.0.1:${server.port}/`,
    stop: () => server.stop(true),
  }
}
