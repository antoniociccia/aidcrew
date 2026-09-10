import type { Tool } from '@aidcrew/core'
import { type McpToolResult, renderResult } from '@aidcrew/mcp-bridge'
import { defineTool } from '@aidcrew/plugin-sdk'
import { z } from 'zod'

export type BrowserCall = (
  name: string,
  args: Record<string, unknown>,
  signal: AbortSignal,
) => Promise<McpToolResult>

export function browserInstructions(runtime: string): string {
  return `Browser capability (browser-chromium plugin): when implementing or checking a web UI, use the available browser tools proactively. No user reminder or project instruction file is needed.
Start with browser_inspect action=pages and reuse the project's visible tab. Each page operation requires its pageId. After starting the app, browser_navigate action=open loads its URL; action=reload refreshes after changes. A connection-error page cannot live-reload itself.
For a blank or broken page, browser_inspect action=diagnose collects console errors, failed requests and canvas/layout measurements. Fix the observed cause before speculating about camera geometry. browser_evaluate returns small JSON from a JavaScript function; browser_interact uses snapshot UIDs or key names.
Do not launch headless browser shell commands or infer visual correctness from PNG size, color counts or ASCII art. Screenshots are human-review artifacts, not model vision. Keep the user's desktop focus; coordinate page ownership with other agents and use isolatedContext for separate players.
Keep the preview detached from tool timeouts. The installed runtime helper is ${JSON.stringify(runtime)}: invoke it with python3, preview start --cwd <actual implementation checkout>; status reports health/PID/log and restart uses only its owned process. Do not use broad pkill, setsid or assume GNU timeout on macOS.
Use browser_help only for additional examples. After two unsuccessful diagnostic cycles, report concrete evidence and change approach. Describe outcomes to the user; do not ask them to configure tools or explain this internal workflow unless it is actually blocked.`
}

export const BROWSER_HELP = `Use this plugin on the existing visible Chromium; never launch headless screenshot shell commands or kill all browsers.
1. browser_inspect action=pages returns page IDs. Reuse the project's tab.
2. browser_navigate action=open with pageId and project URL after the server is ready; action=reload for saved changes.
3. browser_inspect action=diagnose with pageId reads errors, requests and canvas/layout measurements in one call. Fix measured failures before changing camera geometry.
4. browser_evaluate accepts a JavaScript FUNCTION STRING returning small JSON, e.g. () => ({frames: window.__aidcrewDebug?.frames}). For WebGL projects expose dev-only camera, render size, draw calls and frame count. No credentials in diagnostic data.
5. browser_inspect action=snapshot returns DOM element UIDs. browser_interact uses these UIDs, or action=press_key with value="Space". Never infer coordinates from unseen screenshots.
browser_screenshot saves evidence for a HUMAN; this harness returns text, not image vision. File sizes, color counts and ASCII maps do not prove the camera is wrong. A DOM snapshot also cannot describe a 3D canvas scene.
For multiplayer use browser_navigate action=new with isolatedContext="player-b" and keep the returned pageId. Coordinate tab ownership with other agents; never resize, close or navigate their tabs.
All calls are bounded; after two failed diagnostic cycles report the concrete blocker instead of repeating speculative changes. HTTP 200 and frame callbacks alone are not gameplay acceptance.
Do not open the DevTools UI or steal desktop focus. A browser error page needs navigation after server start; it cannot live-reload itself. OBS window capture across macOS Spaces must be checked independently with a saved recording.`

export const DIAGNOSE = `async () => {
  let frames = 0, active = true;
  const tick = () => { if (active) { frames++; requestAnimationFrame(tick); } };
  requestAnimationFrame(tick);
  await new Promise(resolve => setTimeout(resolve, 350)); active = false;
  return {url: location.origin + location.pathname, ready: document.readyState,
    visibility: document.visibilityState,
    viewport: {width: innerWidth, height: innerHeight, dpr: devicePixelRatio},
    animationCallbacksIn350ms: frames,
    canvases: [...document.querySelectorAll('canvas')].slice(0,8).map(c => {
      const r = c.getBoundingClientRect();
      return {width:c.width,height:c.height,cssWidth:r.width,cssHeight:r.height,
        x:r.x,y:r.y,display:getComputedStyle(c).display};
    })};
}`

function page(value?: number): number {
  if (value === undefined)
    throw new Error('pageId is required. Call browser_inspect action=pages first.')
  return value
}

function required(value: string | undefined, field: string): string {
  if (!value) throw new Error(`${field} is required for this action.`)
  return value
}

export function createBrowserTools(call: BrowserCall): Tool[] {
  async function output(name: string, args: Record<string, unknown>, signal: AbortSignal) {
    const result = await call(name, args, signal)
    return { content: renderResult(result), ...(result.isError ? { isError: true } : {}) }
  }
  return [
    defineTool({
      name: 'browser_help',
      description: 'Additional Chromium workflow examples and limits when needed.',
      schema: z.object({}),
      async run() {
        return { content: BROWSER_HELP }
      },
    }),
    defineTool({
      name: 'browser_inspect',
      description:
        'Inspect the visible Chromium. Start with pages; diagnose collects console errors, network and canvas sizes.',
      schema: z.object({
        action: z.enum(['pages', 'diagnose', 'snapshot', 'console', 'network']),
        pageId: z.number().int().optional(),
      }),
      async run(input, context) {
        if (input.action === 'pages') return output('list_pages', {}, context.signal)
        const pageId = page(input.pageId)
        if (input.action === 'snapshot') return output('take_snapshot', { pageId }, context.signal)
        if (input.action === 'console')
          return output(
            'list_console_messages',
            { pageId, types: ['error', 'warn'], pageSize: 10 },
            context.signal,
          )
        if (input.action === 'network')
          return output('list_network_requests', { pageId, pageSize: 10 }, context.signal)
        const parts = []
        for (const [name, args] of [
          ['list_console_messages', { pageId, types: ['error', 'warn'], pageSize: 10 }],
          ['list_network_requests', { pageId, pageSize: 10 }],
          ['evaluate_script', { pageId, function: DIAGNOSE }],
        ] as const) {
          const result = await output(name, args, context.signal)
          parts.push(result.content)
          if (result.isError) return { content: parts.join('\n'), isError: true }
        }
        return { content: parts.join('\n') }
      },
    }),
    defineTool({
      name: 'browser_navigate',
      description:
        'Open/reload an existing page, or create/close a test page. Use pages first; isolatedContext separates multiplayer identities.',
      schema: z.object({
        action: z.enum(['open', 'reload', 'new', 'close']),
        pageId: z.number().int().optional(),
        url: z.string().url().optional(),
        isolatedContext: z.string().optional(),
      }),
      async run(input, context) {
        if (input.action === 'new')
          return output(
            'new_page',
            {
              url: required(input.url, 'url'),
              background: true,
              timeout: 10000,
              ...(input.isolatedContext ? { isolatedContext: input.isolatedContext } : {}),
            },
            context.signal,
          )
        const pageId = page(input.pageId)
        if (input.action === 'close') return output('close_page', { pageId }, context.signal)
        return output(
          'navigate_page',
          {
            pageId,
            timeout: 10000,
            ...(input.action === 'reload'
              ? { type: 'reload', ignoreCache: true }
              : { type: 'url', url: required(input.url, 'url') }),
          },
          context.signal,
        )
      },
    }),
    defineTool({
      name: 'browser_evaluate',
      description:
        'Run a JavaScript function in the selected page and return small JSON runtime evidence. Do not dump bundles, secrets or images.',
      schema: z.object({ pageId: z.number().int(), function: z.string().min(1) }),
      async run(input, context) {
        return output('evaluate_script', input, context.signal)
      },
    }),
    defineTool({
      name: 'browser_interact',
      description:
        'Interact with an observed DOM uid (click/fill) or press a key, e.g. value="Space". Read a snapshot for UIDs.',
      schema: z.object({
        pageId: z.number().int(),
        action: z.enum(['click', 'fill', 'press_key']),
        uid: z.string().optional(),
        value: z.string().optional(),
      }),
      async run(input, context) {
        const { pageId, action } = input
        if (action === 'press_key')
          return output(action, { pageId, key: required(input.value, 'value') }, context.signal)
        const uid = required(input.uid, 'uid')
        if (action === 'fill' && input.value === undefined)
          throw new Error('value is required for fill.')
        return output(
          action,
          { pageId, uid, ...(action === 'fill' ? { value: input.value } : {}) },
          context.signal,
        )
      },
    }),
    defineTool({
      name: 'browser_screenshot',
      description:
        'Save a screenshot for human review to an absolute temporary file path. Returned text is NOT model vision.',
      schema: z.object({ pageId: z.number().int(), filePath: z.string().min(1) }),
      async run(input, context) {
        return output('take_screenshot', input, context.signal)
      },
    }),
  ]
}
