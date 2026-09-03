import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { VERSION } from './version.ts'

const entry = join(import.meta.dir, 'bin.ts')

test('--version reaches a pipe whole, with the process exiting 0', async () => {
  // Written and then the process exits, which is fine on a terminal and was
  // not on a Windows pipe: the text was still in the buffer when the exit
  // dropped it, and the release job read an empty string.
  const run = Bun.spawn(['bun', entry, '--version'], { stdout: 'pipe', stderr: 'pipe' })
  const [out, code] = await Promise.all([new Response(run.stdout).text(), run.exited])

  expect(out).toBe(`${VERSION}\n`)
  expect(code).toBe(0)
})
