import { describe, expect, test } from 'bun:test'
import { EventEmitter } from 'node:events'
import { render } from 'ink'
import { GRAPHITE } from '../theme.ts'
import { ThemeProvider } from '../theme-context.tsx'
import type { SettingsProps } from './settings.tsx'
import { Settings } from './settings.tsx'

const tick = () => new Promise((resolve) => setTimeout(resolve, 12))

function mount(over: Partial<SettingsProps> = {}) {
  const frames: string[] = []
  const stdout = Object.assign(new EventEmitter(), {
    write: (chunk: string) => {
      frames.push(chunk)
      return true
    },
    columns: 120,
    rows: 32,
    isTTY: true,
  })

  let queued: string | undefined
  const stdin = Object.assign(new EventEmitter(), {
    isTTY: true,
    setRawMode: () => {},
    setEncoding: () => {},
    read: () => {
      const chunk = queued
      queued = undefined
      return chunk ?? null
    },
    resume: () => {},
    pause: () => {},
    ref: () => {},
    unref: () => {},
  })

  const props: SettingsProps = {
    known: [],
    providers: ['opencode-go'],
    agents: [],
    models: [],
    defaults: {},
    themes: [
      { name: 'crew', fill: 'hairline' as const },
      { name: 'crew', fill: 'solid' as const },
      { name: 'graphite', fill: 'solid' as const },
    ],
    theme: 'crew',
    plugins: [],
    sources: [],
    sharedMemory: false,
    hidePaths: false,
    cwd: '/repo',
    storePath: '/store',
    onSetKey: async () => {},
    onForgetKey: async () => {},
    onSetDefault: () => {},
    onSharedMemory: () => {},
    onHidePaths: () => {},
    onSetTheme: () => {},
    onSetFill: () => {},
    onSetSources: () => {},
    onWritePlugin: () => {},
    onClose: () => {},
    ...over,
  } as SettingsProps

  const app = render(
    <ThemeProvider value={GRAPHITE}>
      <Settings {...props} />
    </ThemeProvider>,
    { stdin: stdin as never, stdout: stdout as never, patchConsole: false },
  )

  return {
    frame: () => frames.join(''),
    send: async (data: string) => {
      queued = data
      stdin.emit('readable')
      await tick()
    },
    unmount: () => app.unmount(),
  }
}

/**
 * Choosing a look.
 *
 * Which hues and how much of the screen is painted in them are two settings
 * underneath, because they are orthogonal. Offering them that way — a list of
 * palettes plus a key that switched the fill — made half the choice invisible:
 * you cannot pick from a list what the list does not show, and the half that
 * had just been added was the half nobody could find.
 */
describe('the look tab', () => {
  const RIGHT = `${String.fromCharCode(27)}[C`
  const DOWN = `${String.fromCharCode(27)}[B`

  test('lists a row for every palette in every fill', async () => {
    // Asked by reaching the last of them. Offered as a palette list plus a key
    // that switched the fill, half the choice was invisible — and a list that
    // does not show a thing cannot be used to pick it.
    const picked: string[] = []
    const filled: string[] = []
    const ui = mount({
      onSetTheme: (name) => picked.push(name),
      onSetFill: (fill) => filled.push(fill),
    })
    await tick()
    await ui.send(RIGHT)
    await ui.send(RIGHT)
    await ui.send(DOWN)
    await ui.send(DOWN)
    await ui.send('\r')

    expect(picked).toEqual(['graphite'])
    expect(filled).toEqual(['solid'])
    ui.unmount()
  })

  test('choosing a row sets the palette and the fill together', async () => {
    const picked: string[] = []
    const filled: string[] = []
    const ui = mount({
      onSetTheme: (name) => picked.push(name),
      onSetFill: (fill) => filled.push(fill),
    })
    await tick()
    await ui.send(RIGHT)
    await ui.send(RIGHT)
    await ui.send('\r')

    expect(picked).toEqual(['crew'])
    expect(filled).toEqual(['hairline'])
    ui.unmount()
  })
})
