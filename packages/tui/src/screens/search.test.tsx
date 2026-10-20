import { describe, expect, test } from 'bun:test'
import { homedir } from 'node:os'
import { render } from 'ink-testing-library'
import { Search, searchTranscript } from './search.tsx'

const lines = [
  { agentId: 'coder', kind: 'say' as const, text: 'First NEEDLE result' },
  { agentId: 'reviewer', kind: 'error' as const, text: 'needle private result' },
  { agentId: 'coder', kind: 'tool' as const, text: 'Second needle result' },
]

describe('transcript search', () => {
  test('finds literal matches for one agent newest first', () => {
    expect(searchTranscript(lines, 'coder', ' needle ').map((match) => match.text)).toEqual([
      'Second needle result',
      'First NEEDLE result',
    ])
    expect(searchTranscript(lines, 'coder', '.*')).toEqual([])
    expect(searchTranscript(lines, 'coder', '   ')).toEqual([])
  })

  test('keeps the matching passage of a long message readable', () => {
    const matches = searchTranscript(
      [{ agentId: 'coder', kind: 'say', text: `${'before '.repeat(300)}needle ending` }],
      'coder',
      'needle',
    )
    expect(matches[0]?.text).toContain('needle ending')
    expect(matches[0]?.text.length).toBeLessThan(500)
  })

  test('shows results and navigates without sending messages', async () => {
    let closed = false
    const app = render(
      <Search
        lines={lines}
        agent="coder"
        query="needle"
        rows={18}
        columns={70}
        onClose={() => {
          closed = true
        }}
      />,
    )
    await Bun.sleep(30)
    expect(app.lastFrame()).toContain('1 of 2')
    expect(app.lastFrame()).toContain('Second needle result')
    app.stdin.write('\u001b[B')
    await Bun.sleep(30)
    expect(app.lastFrame()).toContain('2 of 2')
    expect(app.lastFrame()).toContain('First NEEDLE result')
    app.stdin.write('\u001b')
    await Bun.sleep(30)
    expect(closed).toBe(true)
    app.unmount()
  })

  test('explains an empty result', () => {
    const app = render(
      <Search
        lines={lines}
        agent="coder"
        query="absent"
        rows={18}
        columns={70}
        onClose={() => {}}
      />,
    )
    expect(app.lastFrame()).toContain('No matches')
    app.unmount()
  })
})

test('hides home paths in both the query and the matching text', () => {
  const path = `${homedir()}/project/needle.ts`
  const app = render(
    <Search
      lines={[{ agentId: 'coder', kind: 'tool', text: path }]}
      agent="coder"
      query={path}
      hidden
      rows={18}
      columns={100}
      onClose={() => {}}
    />,
  )
  expect(app.lastFrame()).toContain('~/project/needle.ts')
  expect(app.lastFrame()).not.toContain(homedir())
  app.unmount()
})

test('keeps the viewed result stable when new matching lines arrive', async () => {
  const props = { agent: 'coder', query: 'needle', rows: 18, columns: 70, onClose: () => {} }
  const app = render(<Search {...props} lines={lines} />)
  await Bun.sleep(30)
  app.stdin.write('\u001b[B')
  await Bun.sleep(30)
  expect(app.lastFrame()).toContain('First NEEDLE result')
  app.rerender(
    <Search
      {...props}
      lines={[...lines, { agentId: 'coder', kind: 'say', text: 'New needle result' }]}
    />,
  )
  await Bun.sleep(30)
  expect(app.lastFrame()).toContain('First NEEDLE result')
  expect(app.lastFrame()).toContain('2 of 2')
  app.unmount()
})
