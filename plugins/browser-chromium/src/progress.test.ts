import { expect, test } from 'bun:test'
import { BrowserProgress } from './progress.ts'

const result = (yaw: number, cell = '4,4,4', status = 'Inside you') =>
  `Script ran on page and returned:\n\`\`\`json\n${JSON.stringify({
    pos: `pos 4.5,4.0,4.5 yaw ${yaw}`,
    after: { target: '4,3,4', cell, status: `✕ ${status}` },
  })}\n\`\`\``

test('bounds repeated blocked outcomes even when camera values change', () => {
  const progress = new BrowserProgress()
  const signal = new AbortController().signal
  for (let i = 0; i < 5; i++) expect(progress.record(signal, 1, result(i))).toBeUndefined()
  expect(progress.record(signal, 1, result(6))).toContain('without progress')
})

test('a changed target or successful outcome resets the failure streak', () => {
  const progress = new BrowserProgress()
  const signal = new AbortController().signal
  for (let i = 0; i < 5; i++) progress.record(signal, 1, result(i))
  expect(progress.record(signal, 1, result(6, '5,4,4'))).toBeUndefined()
  progress.record(signal, 1, '{"after":{"status":"confirmed"}}')
  expect(progress.record(signal, 1, result(7, '5,4,4'))).toBeUndefined()
})

test('successful orbit observations and independent turns are not blocked', () => {
  const progress = new BrowserProgress()
  const a = new AbortController().signal
  for (let i = 0; i < 12; i++)
    expect(progress.record(a, 1, JSON.stringify({ yaw: i }))).toBeUndefined()
  for (let i = 0; i < 5; i++) progress.record(a, 1, result(i))
  expect(progress.record(new AbortController().signal, 1, result(6))).toBeUndefined()
  expect(progress.record(a, 2, result(6))).toBeUndefined()
})

test('a successful no-errors status does not count as a rejected action', () => {
  const progress = new BrowserProgress()
  const signal = new AbortController().signal
  for (let i = 0; i < 10; i++) {
    expect(progress.record(signal, 1, '{"after":{"status":"no errors"}}')).toBeUndefined()
  }
})
