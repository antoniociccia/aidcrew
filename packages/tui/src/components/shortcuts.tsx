import type { Theme } from '../theme.ts'
import { mix } from '../tint.ts'
import type { Segment } from './row.ts'
import { Surface } from './surface.tsx'

/**
 * Every key, on one board, drawn over the session.
 *
 * What was asked for was a board that appears while control is held down and
 * goes when it is released. A terminal cannot do that: it reports a chord —
 * control and a letter arriving together as one control character — and never
 * the modifier on its own, so there is no press to open on and no release to
 * close on. The protocol that would allow it (kitty's) is spoken by kitty,
 * ghostty, WezTerm and foot, and not by Terminal.app.
 *
 * So it opens two ways instead, and the second is the one that matters: a
 * control chord bound to nothing opens it. Pressing control and a letter you
 * half-remember is exactly the moment you wanted the board, and it is the only
 * form of "hold control to see" a terminal permits.
 */

export type Shortcut = { keys: string; what: string }

export type ShortcutGroup = { title: string; keys: Shortcut[] }

export function ShortcutBoard({
  groups,
  theme,
  width,
  because,
}: {
  groups: ShortcutGroup[]
  theme: Theme
  width: number
  /** What opened it, when something unbound did. */
  because?: string
}) {
  const inner = Math.max(30, width - 8)
  const pad = (segments: Segment[]): Segment[] => [{ text: '  ' }, ...segments]
  // The widest key column across every group, so the descriptions line up
  // down the whole board rather than per group.
  const column = Math.max(...groups.flatMap((one) => one.keys.map((key) => key.keys.length)), 3)

  return (
    <Surface
      width={inner}
      rows={[
        { background: mix(theme.accent, theme.surface, 0.8), segments: [{ text: ' ' }] },
        {
          background: mix(theme.accent, theme.surface, 0.8),
          segments: pad([
            { text: because ?? 'every key', color: theme.text, bold: true },
            { text: because ? '  — here is the whole board' : '', color: theme.muted },
          ]),
        },
        ...groups.flatMap((group) => [
          { background: theme.surface, segments: [{ text: ' ' }] },
          {
            background: theme.surface,
            segments: pad([{ text: group.title, color: theme.accent, bold: true }]),
          },
          ...group.keys.map((key) => ({
            background: theme.surface,
            segments: pad([
              { text: key.keys.padEnd(column), color: theme.text, bold: true },
              { text: `   ${key.what}`, color: theme.muted },
            ]),
          })),
        ]),
        { background: theme.surface, segments: [{ text: ' ' }] },
        {
          background: theme.surface,
          segments: pad([{ text: 'esc  close', color: theme.muted }]),
        },
        { background: theme.surface, segments: [{ text: ' ' }] },
      ]}
    />
  )
}
