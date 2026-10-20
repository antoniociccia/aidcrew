import { Box, Text, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import { fold } from '../components/text-width.ts'
import { hidePaths } from '../private.ts'
import { SEARCH_TEXT } from '../search-text.ts'
import { useTheme } from '../theme-context.tsx'
import type { Line } from './session.tsx'

/** Literal matching avoids interpreting transcript queries as executable patterns. */
export function searchTranscript(lines: readonly Line[], agent: string, query: string): Line[] {
  const needle = query.trim().toLowerCase()
  if (!needle) return []
  const matches: Line[] = []
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index]
    if (!line || line.agentId !== agent) continue
    const position = line.text.toLowerCase().indexOf(needle)
    if (position < 0) continue
    const start = Math.max(0, position - 100)
    const end = Math.min(line.text.length, position + Math.max(needle.length, 240))
    matches.push({
      ...line,
      text: `${start > 0 ? '…' : ''}${line.text.slice(start, end)}${end < line.text.length ? '…' : ''}`,
    })
  }
  return matches
}

export function Search(props: {
  lines: readonly Line[]
  agent: string
  query: string
  hidden?: boolean
  onClose(): void
  rows?: number
  columns?: number
}) {
  const theme = useTheme()
  const window = useWindowSize()
  const rows = props.rows ?? window.rows
  const columns = props.columns ?? window.columns
  // Freeze the results until search is reopened so streaming cannot move the passage being read.
  const [matches] = useState(() => searchTranscript(props.lines, props.agent, props.query))
  const [cursor, setCursor] = useState(0)
  const at = Math.min(cursor, Math.max(0, matches.length - 1))
  useInput((input, key) => {
    if (key.escape || input === 'q') props.onClose()
    else if (key.downArrow || key.pageDown || input === 'n')
      setCursor(Math.min(matches.length - 1, at + 1))
    else if (key.upArrow || key.pageUp || input === 'p') setCursor(Math.max(0, at - 1))
  })
  const match = matches[at]
  const display = (text: string): string => (props.hidden ? hidePaths(text) : text)
  const body = fold(display(match?.text ?? SEARCH_TEXT.emptyDetail), Math.max(1, columns - 4))
  return (
    <Box flexDirection="column" height={rows} width={columns} paddingX={1}>
      <Text color={theme.accent} bold wrap="truncate">
        {SEARCH_TEXT.title} · {props.agent} · {display(props.query)}
      </Text>
      <Text color={theme.muted}>
        {match
          ? SEARCH_TEXT.position(at + 1, matches.length, SEARCH_TEXT.kinds[match.kind])
          : SEARCH_TEXT.empty}
      </Text>
      <Box flexDirection="column" flexGrow={1} overflow="hidden" paddingTop={1}>
        <Text>{body.slice(0, Math.max(1, rows - 5)).join('\n')}</Text>
      </Box>
      <Text color={theme.muted} wrap="truncate">
        {SEARCH_TEXT.navigation}
      </Text>
    </Box>
  )
}
