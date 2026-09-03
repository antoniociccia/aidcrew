import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { chmodSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { main } from './main.ts'

/**
 * The contract test for providers.
 *
 * The same task, the same tools and the same agent loop, driven through four
 * genuinely different wire formats — one of them a model with no tool calling
 * at all. Adding a provider means adding a way to render the script and
 * nothing else; if it ever means changing what is below, the abstraction
 * leaked.
 */

type Turn = { tool: string; args: unknown } | { text: string }

/** The script every dialect has to express, identically. */
const SCRIPT: Turn[] = [
  { tool: 'bash', args: { command: './check.sh' } },
  { tool: 'read', args: { path: 'math.js' } },
  { tool: 'edit', args: { path: 'math.js', oldString: 'a - b', newString: 'a + b' } },
  { tool: 'bash', args: { command: './check.sh' } },
  { text: 'add was subtracting; the check passes now.' },
]

const sse = (chunks: object[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join('')

/** Dialect 1: OpenAI chat completions, with native tool calls. */
function openAiTurn(turn: Turn, index: number): string {
  const body =
    'text' in turn
      ? sse([
          { choices: [{ index: 0, delta: { content: turn.text } }] },
          { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
        ])
      : sse([
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [
                    { index: 0, id: `c${index}`, function: { name: turn.tool, arguments: '' } },
                  ],
                },
              },
            ],
          },
          {
            choices: [
              {
                index: 0,
                delta: {
                  tool_calls: [{ index: 0, function: { arguments: JSON.stringify(turn.args) } }],
                },
              },
            ],
          },
          { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
        ])
  return `${body}data: [DONE]\n\n`
}

/** Dialect 2: the same endpoint, by a model that can only write text. */
function promptedTurn(turn: Turn): string {
  const text =
    'text' in turn
      ? turn.text
      : `<tool_call>${JSON.stringify({ name: turn.tool, arguments: turn.args })}</tool_call>`

  // Split mid-tag on purpose: real models emit these one token at a time.
  const half = Math.floor(text.length / 2)
  return `${sse([
    { choices: [{ index: 0, delta: { content: text.slice(0, half) } }] },
    { choices: [{ index: 0, delta: { content: text.slice(half) } }] },
    { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
  ])}data: [DONE]\n\n`
}

/** Dialect 3: Anthropic messages, typed block events. */
function anthropicTurn(turn: Turn, index: number): string {
  if ('text' in turn) {
    return sse([
      { type: 'message_start', message: { usage: { input_tokens: 10 } } },
      { type: 'content_block_start', index: 0, content_block: { type: 'text' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: turn.text } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 4 } },
    ])
  }
  return sse([
    { type: 'message_start', message: { usage: { input_tokens: 10 } } },
    {
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: `toolu_${index}`, name: turn.tool },
    },
    {
      type: 'content_block_delta',
      index: 0,
      delta: { type: 'input_json_delta', partial_json: JSON.stringify(turn.args) },
    },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: 4 } },
  ])
}

/** Dialect 4: Gemini generateContent, whole parts rather than deltas. */
function geminiTurn(turn: Turn): string {
  const part =
    'text' in turn ? { text: turn.text } : { functionCall: { name: turn.tool, args: turn.args } }

  return sse([
    {
      candidates: [{ content: { role: 'model', parts: [part] }, finishReason: 'STOP' }],
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 4 },
    },
  ])
}

const DIALECTS = [
  {
    name: 'openai-compatible, native tool calling',
    render: openAiTurn,
    env: (url: string) => ({ AIDCREW_PROVIDER: 'openai-compat', AIDCREW_BASE_URL: url }),
  },
  {
    name: 'openai-compatible, no tool calling at all',
    render: (turn: Turn) => promptedTurn(turn),
    env: (url: string) => ({
      AIDCREW_PROVIDER: 'openai-compat',
      AIDCREW_BASE_URL: url,
      AIDCREW_PROMPTED_TOOLS: '1',
    }),
  },
  {
    name: 'anthropic messages',
    render: anthropicTurn,
    env: (url: string) => ({ AIDCREW_PROVIDER: 'anthropic', AIDCREW_BASE_URL: url }),
  },
  {
    name: 'gemini generateContent',
    render: (turn: Turn) => geminiTurn(turn),
    env: (url: string) => ({ AIDCREW_PROVIDER: 'gemini', AIDCREW_BASE_URL: url }),
  },
]

let root: string
let home: string
let server: ReturnType<typeof Bun.serve> | undefined

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-providers-')))
  home = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-providers-home-')))
  writeFileSync(join(root, 'math.js'), 'export const add = (a, b) => a - b\n')
  writeFileSync(
    join(root, 'check.sh'),
    '#!/bin/bash\nnode -e "import(\'./math.js\').then(m => process.exit(m.add(2, 2) === 4 ? 0 : 1))"\n',
  )
  chmodSync(join(root, 'check.sh'), 0o755)
})

afterEach(() => {
  server?.stop(true)
  server = undefined
  rmSync(root, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
})

describe('one task, every dialect', () => {
  for (const dialect of DIALECTS) {
    test(`fixes the bug through ${dialect.name}`, async () => {
      let turn = 0
      server = Bun.serve({
        port: 0,
        async fetch(request) {
          await request.json()
          const current = SCRIPT[turn] ?? { text: 'done' }
          const body = dialect.render(current, turn)
          turn += 1
          return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
        },
      })

      let out = ''
      const code = await main(
        ['-p', 'the check fails, fix it', '-C', root],
        {
          ...dialect.env(`${server.url.origin}/v1`),
          AIDCREW_API_KEY: 'test-key',
          AIDCREW_MODEL: 'test-model',
        },
        {
          write: (text) => {
            out += text
          },
          writeError: () => {},
          color: false,
        },
        new AbortController().signal,
        { pluginDirs: [], home },
      )

      expect(code).toBe(0)
      expect(readFileSync(join(root, 'math.js'), 'utf8')).toBe(
        'export const add = (a, b) => a + b\n',
      )
      expect(out).toContain('add was subtracting')
    })
  }

  test('the prompted dialect never shows the call markup to the user', async () => {
    // The whole trick has to be invisible, or every answer is full of XML.
    let turn = 0
    server = Bun.serve({
      port: 0,
      async fetch(request) {
        await request.json()
        const body = promptedTurn(SCRIPT[turn] ?? { text: 'done' })
        turn += 1
        return new Response(body, { headers: { 'Content-Type': 'text/event-stream' } })
      },
    })

    let out = ''
    await main(
      ['-p', 'fix it', '-C', root],
      {
        AIDCREW_PROVIDER: 'openai-compat',
        AIDCREW_BASE_URL: `${server.url.origin}/v1`,
        AIDCREW_PROMPTED_TOOLS: '1',
        AIDCREW_API_KEY: 'k',
        AIDCREW_MODEL: 'm',
      },
      {
        write: (text) => {
          out += text
        },
        writeError: () => {},
        color: false,
      },
      new AbortController().signal,
      { pluginDirs: [], home },
    )

    expect(out).not.toContain('tool_call')
  })
})
