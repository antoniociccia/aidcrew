import { expect, test } from 'bun:test'
import { webSession } from './web-session.ts'

test('replacing the React bridge preserves the transport and ignores stale cleanup', async () => {
  const connection = webSession()
  const empty = connection.snapshot()
  expect(empty.ready).toBe(false)
  await expect(connection.dispatch({ type: 'inspect' })).rejects.toThrow('still opening')
  const disconnect = connection.connect({
    snapshot: () => ({ ...empty, cwd: '/first' }),
    dispatch: async () => 'first',
  })
  const stop = connection.connect({
    snapshot: () => ({ ...empty, cwd: '/second' }),
    dispatch: async () => 'second',
  })
  disconnect()
  expect(connection.snapshot().cwd).toBe('/second')
  expect(await connection.dispatch({ type: 'inspect' })).toBe('second')
  stop()
  expect(connection.snapshot().ready).toBe(false)
})
