import { describe, expect, test } from 'bun:test'
import { copyToClipboard } from './clipboard.ts'

describe('putting text on the clipboard', () => {
  test('uses the first command that works', async () => {
    const tried: string[] = []
    const done = await copyToClipboard('hello', async (command) => {
      tried.push(command)
      return command === 'xclip'
    })

    expect(done).toBe(true)
    // Stops at the one that worked rather than running the rest.
    expect(tried).toEqual(['pbcopy', 'wl-copy', 'xclip'])
  })

  test('says so when the machine has none of them', async () => {
    // Told plainly, rather than left wondering whether it worked.
    expect(await copyToClipboard('hello', async () => false)).toBe(false)
  })

  test('hands over exactly what it was given', async () => {
    let seen = ''
    await copyToClipboard('line one\nline two', async (_c, _a, input) => {
      seen = input
      return true
    })

    expect(seen).toBe('line one\nline two')
  })
})
