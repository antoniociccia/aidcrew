import { Box, useInput, useWindowSize } from 'ink'
import type { ShortcutGroup } from '../components/shortcuts.tsx'
import { ShortcutBoard } from '../components/shortcuts.tsx'
import { useTheme } from '../theme-context.tsx'

/**
 * Every key, on one screen.
 *
 * There are fifteen of them and the tray has room for six, so the rest were
 * discoverable only by reading the source. What was asked for was a board that
 * appears while control is held and goes when it is released, which a terminal
 * cannot do: it reports a chord — control and a letter arriving together as
 * one control character — and never the modifier alone. There is no press to
 * open on and no release to close on.
 *
 * A screen instead, like the other four, opened by a key that is itself on the
 * tray so nobody has to remember it.
 */

export const GROUPS: ShortcutGroup[] = [
  {
    title: 'moving around',
    keys: [
      { keys: 'tab', what: 'the next agent — shift-tab for the one before' },
      { keys: '← →', what: 'the same, for a keyboard without tab to spare' },
      { keys: 'pgup pgdn', what: "back and forward through this agent's history" },
      { keys: '^g', what: 'back to the newest' },
      { keys: '^b ^f', what: 'a page back, a page forward' },
    ],
  },
  {
    title: 'writing',
    keys: [
      { keys: 'enter', what: 'send' },
      { keys: '^u', what: 'clear the line' },
      { keys: '^w', what: 'delete the last word — option-backspace does it too' },
      { keys: '^c', what: 'clear the line, or quit when there is nothing on it' },
      { keys: '↑ ↓', what: 'what you sent before, newest first' },
      { keys: '@', what: 'name a file and send it along' },
      { keys: '^t', what: 'find a file by part of its name, for keyboards where @ is awkward' },
      { keys: '/', what: 'a command — /help lists them' },
    ],
  },
  {
    title: 'the team',
    keys: [
      { keys: '^e', what: 'the team: add somebody, or change what they run on' },
      { keys: '^k', what: 'the jobs open in this repository' },
      { keys: '^n', what: 'everything said while you were looking elsewhere' },
      { keys: '^l', what: 'side by side, or back to tabs' },
      { keys: '^← ^→', what: 'move the divider, when side by side' },
      { keys: '^x', what: 'drop what this agent has queued' },
      { keys: 'esc', what: 'stop the turn in flight, leaving the agent standing' },
    ],
  },
  {
    title: 'the session',
    keys: [
      { keys: '^s', what: 'settings' },
      { keys: '^y', what: 'another project' },
      { keys: '^r', what: 'show or hide what the model was thinking' },
      { keys: '^p', what: 'hand the mouse back, so text can be selected' },
      { keys: '^o', what: 'this board' },
    ],
  },
]

export function Keys({
  onClose,
  because,
  rows,
  columns,
}: {
  onClose(): void
  /** What opened it, when an unbound chord did. */
  because?: string
  rows?: number
  columns?: number
}) {
  const theme = useTheme()
  const window = useWindowSize()

  useInput(() => onClose())

  return (
    <Box flexDirection="column" height={rows ?? window.rows} width={columns ?? window.columns}>
      <ShortcutBoard
        groups={GROUPS}
        theme={theme}
        width={columns ?? window.columns}
        {...(because ? { because } : {})}
      />
    </Box>
  )
}
