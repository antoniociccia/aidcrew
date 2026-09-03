import { describe, expect, test } from 'bun:test'
import { isMouse, parseMouse, withoutMouse } from './mouse.ts'

const press = (button: number, column: number, row: number, ending = 'M') =>
  `\u001b[<${button};${column};${row}${ending}`

describe('reading the mouse', () => {
  test('reports a left press where it happened', () => {
    expect(parseMouse(press(0, 12, 3))).toEqual([
      { kind: 'down', column: 11, row: 2, button: 'left' },
    ])
  })

  test('counts from zero, so a coordinate indexes a row directly', () => {
    // The terminal counts from one; every consumer here counts from zero.
    expect(parseMouse(press(0, 1, 1))[0]).toMatchObject({ column: 0, row: 0 })
  })

  test('tells a release apart from a press by the letter that ends it', () => {
    expect(parseMouse(press(0, 5, 5, 'm'))[0]?.kind).toBe('up')
  })

  test('reads motion with a button held as a drag', () => {
    // 32 is the motion bit; without it the same code is a fresh press.
    expect(parseMouse(press(32, 5, 5))[0]?.kind).toBe('drag')
  })

  test('names the button that was pressed', () => {
    expect(parseMouse(press(2, 1, 1))[0]?.button).toBe('right')
  })

  test('reads the wheel, and which way it turned', () => {
    expect(parseMouse(press(64, 1, 1))[0]).toMatchObject({ kind: 'wheel', direction: 'up' })
    expect(parseMouse(press(65, 1, 1))[0]).toMatchObject({ kind: 'wheel', direction: 'down' })
  })

  test('reads a burst of events arriving in one chunk', () => {
    const events = parseMouse(press(0, 1, 1) + press(32, 2, 1) + press(0, 3, 1, 'm'))

    expect(events.map((event) => event.kind)).toEqual(['down', 'drag', 'up'])
  })

  test('reads a report whose escape Ink has already eaten', () => {
    expect(parseMouse('[<0;12;3M')).toEqual([{ kind: 'down', column: 11, row: 2, button: 'left' }])
  })

  test('finds nothing in ordinary typing', () => {
    expect(parseMouse('hello')).toEqual([])
  })

  test('works past column 223, where the old encoding gives up', () => {
    expect(parseMouse(press(0, 400, 90))[0]).toMatchObject({ column: 399, row: 89 })
  })
})

describe('telling mouse reporting from typing', () => {
  test('recognises a chunk that is mouse reporting', () => {
    expect(isMouse(press(0, 1, 1))).toBe(true)
    expect(isMouse(press(0, 1, 1) + press(0, 1, 1, 'm'))).toBe(true)
  })

  test('recognises it with the escape already eaten', () => {
    // Ink parses key presses first and hands on what it did not recognise,
    // without the escape — which is how `[<0;70;3M` ended up inside a draft.
    expect(isMouse('[<0;70;3M')).toBe(true)
  })

  test('does not claim typed text', () => {
    expect(isMouse('y')).toBe(false)
    expect(isMouse('bash ls')).toBe(false)
  })

  test('keeps the letter when a click lands in the same read as typing', () => {
    expect(withoutMouse(`${press(0, 1, 1)}y`)).toBe('y')
    expect(withoutMouse('a[<0;1;1Mb')).toBe('ab')
  })

  test('leaves ordinary text alone', () => {
    expect(withoutMouse('run the tests')).toBe('run the tests')
  })
})
