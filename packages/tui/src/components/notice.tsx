import type { Theme } from '../theme.ts'
import { mix } from '../tint.ts'
import type { Segment } from './row.ts'
import { Surface } from './surface.tsx'

/**
 * Something the session has to say that is nobody's news in particular.
 *
 * Every other line in this interface is filed under an agent and drawn in that
 * agent's pane, which is right for everything an agent did. It is wrong for
 * the three things that belong to the session: what the project's config asked
 * for and did not get, what a plugin wants to ask you before it acts, and the
 * fact that the whole team has stopped with work outstanding. Filed under an
 * agent, each of those is a line in a pane you may not be looking at — and the
 * last one is a complaint about silence hidden inside the silence.
 *
 * So it is drawn across the middle, over whatever is there. That is a strong
 * thing to do to somebody's screen, which is why there are exactly three
 * inhabitants and why every one of them ends with the key that makes it go
 * away.
 */
export type SessionNotice = {
  /** One line, said plainly. This is the whole message for most readers. */
  title: string
  /** What is known about it, one line each. Empty is fine. */
  detail: string[]
  /**
   * What can be done, as `key` and what it does.
   *
   * What ends the state rather than what hides it. This is drawn only while
   * nothing is happening and goes the moment something does, so there is
   * nothing to dismiss — and offering a key that only hides it would teach
   * people to press it, which is how the one notice that mattered gets shut
   * before it is read.
   */
  keys: [string, string][]
  /** How loud. `ask` is waiting on somebody; `tell` has already happened. */
  tone: 'ask' | 'tell'
  /**
   * The agent the notice is about, when enter should reach it.
   *
   * A stall ends by telling somebody something, and the notice says "↵ tell
   * coder to carry on" — so enter on an empty line, in that agent's field,
   * has to do exactly that rather than nothing.
   */
  to?: string
}

export function NoticeBox({
  notice,
  theme,
  width,
}: {
  notice: SessionNotice
  theme: Theme
  width: number
}) {
  const accent = notice.tone === 'ask' ? theme.warn : theme.muted
  // Inset, so the thing underneath is still visible at the edges and the
  // notice reads as being over the session rather than as being the session.
  const inner = Math.max(20, width - 8)
  const pad = (segments: Segment[]): Segment[] => [{ text: '  ' }, ...segments]

  return (
    <Surface
      width={inner}
      rows={[
        { background: mix(accent, theme.surface, 0.76), segments: [{ text: ' ' }] },
        {
          background: mix(accent, theme.surface, 0.76),
          segments: pad([{ text: notice.title, color: theme.text, bold: true }]),
        },
        { background: theme.surface, segments: [{ text: ' ' }] },
        // Wrapped rather than truncated. A surface is a fixed width and cuts
        // what does not fit, which for a line of prose throws away the half
        // that says what to do — and this notice exists because something was
        // not said.
        ...notice.detail.flatMap((line) =>
          wrap(line, inner - 4).map((part) => ({
            background: theme.surface,
            segments: pad([{ text: part, color: theme.muted }]),
          })),
        ),
        { background: theme.surface, segments: [{ text: ' ' }] },
        {
          background: theme.surface,
          segments: pad(
            notice.keys.flatMap(([key, what]) => [
              { text: ` ${key} `, color: theme.onVoice, bold: true, background: accent },
              { text: `  ${what}   `, color: theme.muted },
            ]),
          ),
        },
        { background: theme.surface, segments: [{ text: ' ' }] },
      ]}
    />
  )
}

/** One line broken at spaces to fit, keeping a very long word whole. */
function wrap(line: string, width: number): string[] {
  const out: string[] = []
  let held = ''
  for (const word of line.split(' ')) {
    if (held === '') held = word
    else if (`${held} ${word}`.length <= width) held = `${held} ${word}`
    else {
      out.push(held)
      held = word
    }
  }
  if (held !== '') out.push(held)
  return out
}
