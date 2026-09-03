import { describe, expect, test } from 'bun:test'
import { oneAtATime } from './one-at-a-time.ts'

/**
 * Two agents asking at once.
 *
 * The screen holds one question. A second arriving while the first was up
 * replaced it, and the first agent's promise was never answered: its turn sat
 * at "working" for the rest of the session with no mark on its tab.
 */
describe('questions put one at a time', () => {
  test('the second waits until the first is answered', async () => {
    const ask = oneAtATime()
    const order: string[] = []
    let answerFirst = (): void => {}

    const first = ask(
      () =>
        new Promise<string>((resolve) => {
          answerFirst = () => resolve('first')
        }),
    )
    const second = ask(async () => {
      order.push('second asked')
      return 'second'
    })

    await Bun.sleep(5)
    expect(order).toEqual([])
    answerFirst()

    expect(await first).toBe('first')
    expect(await second).toBe('second')
    expect(order).toEqual(['second asked'])
  })

  test('a refused first question does not block the second', async () => {
    const ask = oneAtATime()
    const first = ask(() => Promise.reject(new Error('no')))
    const second = ask(async () => 'yes')

    await expect(first).rejects.toThrow('no')
    expect(await second).toBe('yes')
  })
})
