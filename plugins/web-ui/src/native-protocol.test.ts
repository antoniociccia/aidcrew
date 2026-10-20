import { expect, test } from 'bun:test'
import { parseTerminalMessage, terminalSize } from './native-protocol.ts'

test('accepts native output literally, including terminal control sequences', () => {
  const data = '\u001b[31mhello\u001b[0m\r\n'
  expect(parseTerminalMessage(JSON.stringify({ type: 'output', data }))).toEqual({
    type: 'output',
    data,
  })
  expect(parseTerminalMessage('{"type":"ready"}')).toEqual({ type: 'ready' })
  expect(parseTerminalMessage('{"type":"exit","code":0}')).toEqual({ type: 'exit', code: 0 })
  expect(parseTerminalMessage('{"type":"exit","code":null}')).toEqual({ type: 'exit', code: null })
})

test('rejects malformed transport frames instead of treating them as terminal output', () => {
  for (const value of [
    'bad json',
    '{}',
    '{"type":"output","data":5}',
    '{"type":"exit","code":"0"}',
  ]) {
    expect(parseTerminalMessage(value)).toBeUndefined()
  }
})

test('normalizes terminal dimensions to finite bounded integers', () => {
  expect(terminalSize(80, 24)).toEqual({ cols: 80, rows: 24 })
  expect(terminalSize(80.7, 24.1)).toEqual({ cols: 80, rows: 24 })
  expect(terminalSize(0, -5)).toEqual({ cols: 2, rows: 1 })
  expect(terminalSize(5000, 5000)).toEqual({ cols: 500, rows: 300 })
  expect(terminalSize(Number.NaN, Number.POSITIVE_INFINITY)).toEqual({ cols: 80, rows: 24 })
})
