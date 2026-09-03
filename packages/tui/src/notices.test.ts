import { describe, expect, test } from 'bun:test'
import { askingNotice, noticeFor, seeing, total, unseenBy } from './notices.ts'

const line = (agentId: string, kind: string, text: string) =>
  ({ agentId, kind, text }) as Parameters<typeof noticeFor>[0]

describe('what is worth a notice', () => {
  test('a failure is, because nobody is watching that pane', () => {
    const notice = noticeFor(line('coder', 'error', 'zen: no credit'), 1, 0)

    expect(notice).toMatchObject({ agentId: 'coder', weight: 'failed' })
  })

  test('something that happened without being asked for is', () => {
    // A handoff, a compaction, a queue dropped: you did not ask, and you would
    // want to know.
    expect(noticeFor(line('coder', 'note', '← architect: do the thing'), 1, 0)).toMatchObject({
      weight: 'note',
    })
  })

  test('what an agent says is not, because that is the work itself', () => {
    // Reading a pane you are looking at should never also ring a bell.
    expect(noticeFor(line('coder', 'say', 'all green'), 1, 0)).toBeUndefined()
    expect(noticeFor(line('coder', 'tool', 'bash bun test'), 1, 0)).toBeUndefined()
    expect(noticeFor(line('coder', 'thinking', 'hmm'), 1, 0)).toBeUndefined()
  })

  test('collapses a message to one line, since a bell is not a transcript', () => {
    const notice = noticeFor(line('coder', 'error', 'one\n\ntwo   three'), 1, 0)

    expect(notice?.text).toBe('one two three')
  })
})

describe('what each tab should show', () => {
  const notices = [
    askingNotice('reviewer', 'rm -rf build', 1, 0),
    noticeFor(line('coder', 'note', 'a'), 2, 0),
    noticeFor(line('coder', 'error', 'b'), 3, 0),
  ].filter((notice) => notice !== undefined)

  test('counts what has not been seen, per agent', () => {
    const by = unseenBy(notices)

    expect(by.get('coder')?.count).toBe(2)
    expect(by.get('reviewer')?.count).toBe(1)
  })

  test('takes the loudest one, because that decides the colour', () => {
    // A question stops work; the rest merely happened.
    expect(unseenBy(notices).get('coder')?.weight).toBe('failed')
    expect(unseenBy(notices).get('reviewer')?.weight).toBe('asking')
  })

  test('says nothing for an agent with nothing waiting', () => {
    expect(unseenBy(notices).get('architect')).toBeUndefined()
  })
})

describe('reading them', () => {
  const notices = [
    askingNotice('reviewer', 'x', 1, 0),
    noticeFor(line('coder', 'error', 'b'), 2, 0) as ReturnType<typeof askingNotice>,
  ]

  test('looking at a pane is what reading its notices means', () => {
    // Anything else asks you to tell the interface something it can see you
    // doing.
    const after = seeing(notices, 'coder')

    expect(unseenBy(after).get('coder')).toBeUndefined()
    expect(unseenBy(after).get('reviewer')?.count).toBe(1)
  })

  test('the bell for the whole screen counts what is left anywhere', () => {
    expect(total(notices)).toBe(2)
    expect(total(seeing(notices, 'coder'))).toBe(1)
  })
})
