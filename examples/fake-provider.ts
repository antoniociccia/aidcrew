#!/usr/bin/env bun
/**
 * A model that does not exist, for trying aidcrew without an API key.
 *
 * It speaks the OpenAI chat-completions dialect and replays a fixed script:
 * run the project's check, read the file, fix it, run the check again. Enough
 * to see the whole loop work against real files on disk.
 *
 *   bun examples/fake-provider.ts
 *
 * Then, in another terminal, follow docs/getting-started.md.
 */

type Step = { tool: string; args: unknown } | { text: string }

const SCRIPT: Step[] = [
  { tool: 'bash', args: { command: './check.sh' } },
  { tool: 'read', args: { path: 'math.js' } },
  { tool: 'edit', args: { path: 'math.js', oldString: 'a - b', newString: 'a + b' } },
  { tool: 'bash', args: { command: './check.sh' } },
  { text: 'add was subtracting instead of adding. The check passes now.' },
]

const turns = new Map<string, number>()

function chunks(step: Step | undefined, index: number): object[] {
  if (!step) {
    return [
      { choices: [{ index: 0, delta: { content: 'nothing left to do.' } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
  }

  if ('text' in step) {
    return [
      { choices: [{ index: 0, delta: { content: step.text } }] },
      { choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] },
    ]
  }

  return [
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, id: `call_${index}`, function: { name: step.tool } }] },
        },
      ],
    },
    {
      choices: [
        {
          index: 0,
          delta: { tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] },
        },
      ],
    },
    { choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }] },
  ]
}

const server = Bun.serve({
  port: Number(Bun.env.PORT ?? 8787),
  async fetch(request) {
    const body = (await request.json()) as { model: string }

    // Scripts advance per model, so a team on several models each get their own.
    const index = turns.get(body.model) ?? 0
    turns.set(body.model, index + 1)

    const payload = chunks(SCRIPT[index], index)
      .map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`)
      .join('')

    return new Response(`${payload}data: [DONE]\n\n`, {
      headers: { 'Content-Type': 'text/event-stream' },
    })
  },
})

console.log(`fake provider listening on ${server.url.origin}/v1`)
console.log('point AIDCREW_BASE_URL at it and run aidcrew in the sample project.')
