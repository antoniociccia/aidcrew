import { expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { openRuntime, readProject, startTeam } from './runtime.ts'

test('restricted UI agents receive the bundled and discovered local skill catalog', async () => {
  const cwd = mkdtempSync(join(tmpdir(), 'aidcrew-default-skills-'))
  mkdirSync(join(cwd, '.claude/skills/local-rule'), { recursive: true })
  writeFileSync(
    join(cwd, '.claude/skills/local-rule/SKILL.md'),
    '---\nname: local-rule\ndescription: Local integration guidance\n---\nPRIVATE BODY\n',
  )
  const requests: { tools: { function: { name: string } }[]; messages: unknown[] }[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      requests.push((await request.json()) as (typeof requests)[number])
      return new Response(
        'data: ' +
          JSON.stringify({ choices: [{ index: 0, delta: { content: 'done' } }] }) +
          '\n\ndata: ' +
          JSON.stringify({
            choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
            usage: { prompt_tokens: 1, completion_tokens: 1 },
          }) +
          '\n\ndata: [DONE]\n\n',
        { headers: { 'Content-Type': 'text/event-stream' } },
      )
    },
  })
  const runtime = await openRuntime(cwd, cwd)
  let live: Awaited<ReturnType<typeof startTeam>> | undefined
  try {
    const env = { AIDCREW_API_KEY: 'test', AIDCREW_BASE_URL: server.url.origin + '/v1' }
    const project = await readProject(runtime, cwd, cwd, env)
    expect(project.skills.map((skill) => skill.name)).toContain('local-rule')
    live = await startTeam({
      runtime,
      cwd,
      env,
      agents: [
        {
          id: 'reviewer',
          description: 'review',
          systemPrompt: 'Review',
          provider: 'openai-compat',
          model: 'test',
          tools: [],
        },
      ],
      skills: project.skills,
      defaultProvider: 'openai-compat',
      onChange: () => {},
    })
    await live.tell('reviewer', 'Check available guidance')
    await live.idle()
    const first = requests[0]
    if (!first) throw new Error('No model request')
    expect(first.tools.map((tool) => tool.function.name)).toContain('skill')
    expect(first.tools.map((tool) => tool.function.name)).not.toContain('bash')
    expect(JSON.stringify(first.messages)).toContain('decision-lab')
    expect(JSON.stringify(first.messages)).toContain('Local integration guidance')
    expect(JSON.stringify(first.messages)).not.toContain('PRIVATE BODY')
  } finally {
    await live?.shutdown()
    runtime.store.close()
    server.stop(true)
    rmSync(cwd, { recursive: true, force: true })
  }
})
