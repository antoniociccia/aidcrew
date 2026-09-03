import { Box, Text, useInput } from 'ink'
import { useState } from 'react'
import type { Entry } from '../browse.ts'
import { list } from '../browse.ts'
import { useTheme } from '../theme-context.tsx'
import { headerTint } from '../tint.ts'
import { Surface } from './surface.tsx'

/**
 * Choosing a directory by walking to it.
 *
 * Typing a path into a field means knowing it exactly and spelling it right,
 * and being told nothing when you do not. Walking there shows what is
 * actually on the disk, which is also the only way to find out that the
 * directory you meant is called `agents` and not `agent`.
 */
export function Picker({
  start,
  title,
  rows,
  columns,
  onChoose,
  onCancel,
}: {
  start: string
  title: string
  rows: number
  columns: number
  onChoose(path: string): void
  onCancel(): void
}) {
  const theme = useTheme()
  const [at, setAt] = useState(start)
  const [cursor, setCursor] = useState(0)

  const entries: Entry[] = list(at)
  const here = entries[cursor]

  useInput((input, key) => {
    if (key.escape) return onCancel()
    if (key.upArrow) return setCursor((was) => Math.max(0, was - 1))
    if (key.downArrow) return setCursor((was) => Math.min(entries.length - 1, was + 1))

    // Enter walks into a directory; choosing is a separate key, because the
    // thing being picked is a directory you are standing in, not one you can
    // see from outside.
    if (key.return && here) {
      setAt(here.path)
      setCursor(0)
      return
    }
    if (input === 's') onChoose(at)
  })

  // Only what fits, following the cursor rather than paging under it.
  const room = Math.max(3, rows - 6)
  const from = Math.max(0, Math.min(cursor - Math.floor(room / 2), entries.length - room))
  const shown = entries.slice(from, from + room)

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Box paddingX={1} flexDirection="column">
        <Text bold color={theme.accent}>
          {title}
        </Text>
        <Text color={theme.muted}>{at}</Text>
      </Box>

      <Box marginTop={1} flexGrow={1}>
        <Surface
          width={columns}
          rows={shown.map((entry, index) => ({
            ...(from + index === cursor
              ? { background: headerTint(theme.accent, theme.surface) }
              : {}),
            segments: [
              { text: '  ' },
              {
                text: entry.up ? '↑ ..' : `▸ ${entry.name}`,
                color: from + index === cursor ? theme.accent : theme.muted,
                bold: from + index === cursor,
              },
            ],
          }))}
        />
      </Box>

      <Box paddingX={1}>
        <Text color={theme.faint}>
          enter open · <Text color={theme.ok}>s</Text> use this directory · esc cancel
        </Text>
      </Box>
    </Box>
  )
}
