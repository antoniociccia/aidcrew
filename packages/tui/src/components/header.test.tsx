import { describe, expect, test } from 'bun:test'
import { render } from 'ink-testing-library'
import { wordmarkText } from '../logo.ts'
import { CREW } from '../theme.ts'
import { ThemeProvider } from '../theme-context.tsx'
import { Header } from './chrome.tsx'

describe('the band at the top of a screen', () => {
  test('carries the wordmark, the same one the tray carries', () => {
    // The wizard, the tour, the team editor and the list of projects each
    // wrote "aidcrew" in plain bold at the top, while the tray under the
    // session drew the mark — the spaced letters and the filled D. Two logos
    // for one program, and the plain one on the screens a newcomer sees
    // first. The band draws the mark.
    const { lastFrame } = render(
      <ThemeProvider value={CREW}>
        <Header title="setup" subtitle="step 1 of 5" columns={80} />
      </ThemeProvider>,
    )
    const frame = lastFrame() ?? ''

    expect(frame).toContain(wordmarkText())
    expect(frame).toContain('setup')
    expect(frame).toContain('step 1 of 5')
    expect(frame).not.toMatch(/\baidcrew\b/)
  })
})
