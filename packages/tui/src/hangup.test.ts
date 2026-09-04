import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { leaveOnSignal } from './hangup.ts'

function fakeProcess() {
  const exits: number[] = []
  const emitter = new EventEmitter()
  const proc = Object.assign(emitter, { exit: (code: number) => void exits.push(code) })
  return { proc, exits }
}

describe('when the terminal goes away', () => {
  test('the process closes what it holds and then actually exits', () => {
    // A listener on SIGHUP replaces the default, and the default was the
    // exit. With the store closed and the screen given back, nothing else
    // ended the process — so a closed window left aidcrew running, in the
    // background, with the session and the checkouts, for as long as the
    // machine stayed up. Three of them were found the same afternoon.
    const { proc, exits } = fakeProcess()
    let closed = 0

    leaveOnSignal(proc as never, () => void closed++)
    proc.emit('SIGHUP')

    expect(closed).toBe(1)
    expect(exits).toEqual([129])
  })

  test('the exit code says which signal it was', () => {
    for (const [signal, code] of [
      ['SIGINT', 130],
      ['SIGTERM', 143],
    ] as const) {
      const { proc, exits } = fakeProcess()
      leaveOnSignal(proc as never, () => {})
      proc.emit(signal)
      expect(exits).toEqual([code])
    }
  })

  test('can be undone, for the ordinary way out', () => {
    const { proc, exits } = fakeProcess()
    let closed = 0
    const stop = leaveOnSignal(proc as never, () => void closed++)

    stop()
    proc.emit('SIGTERM')

    expect(closed).toBe(0)
    expect(exits).toEqual([])
  })
})
