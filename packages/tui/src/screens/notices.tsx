import { Box, useInput, useWindowSize } from 'ink'
import type { PaintedRow } from '../components/paint.ts'
import { Row, Surface } from '../components/surface.tsx'
import { wordmark } from '../logo.ts'
import type { Notice } from '../notices.ts'
import type { Theme } from '../theme.ts'
import { useTheme, useVoice } from '../theme-context.tsx'
import { headerTint, mix } from '../tint.ts'

/**
 * Everything that happened while you were looking somewhere else.
 *
 * Newest first, and the ones still wanting something at the top of that:
 * a team runs in panes nobody is watching, and the whole point of a list like
 * this is that it survives not being watched.
 *
 * Choosing one goes to the agent it belongs to, because a notice is never the
 * end of anything — it is a pointer at a pane where the actual thing is.
 */

export type NoticesProps = {
  notices: Notice[]
  agents: string[]
  onGo(agentId: string): void
  onClose(): void
  rows?: number
  columns?: number
}

const LABEL: Record<Notice['weight'], string> = {
  asking: 'waiting on you',
  failed: 'failed',
  done: 'finished',
  note: '',
}

export function Notices(props: NoticesProps) {
  const theme = useTheme()
  const voice = useVoice()
  const window = useWindowSize()
  const rows = props.rows ?? window.rows
  const columns = props.columns ?? window.columns

  // Unseen first, then newest. What still wants something outranks what merely
  // happened, however long ago it happened.
  const order: Notice['weight'][] = ['note', 'done', 'failed', 'asking']
  const sorted = [...props.notices].sort((a, b) => {
    if (a.seen !== b.seen) return a.seen ? 1 : -1
    const weight = order.indexOf(b.weight) - order.indexOf(a.weight)
    return weight !== 0 ? weight : b.at - a.at
  })

  const room = Math.max(1, rows - 4)
  const shown = sorted.slice(0, room)

  useInput((input, key) => {
    if (key.escape || input === 'n') return props.onClose()
    // Number keys are safe here: this screen has nothing to type into.
    const at = Number.parseInt(input, 10)
    const chosen = shown[at - 1]
    if (chosen) props.onGo(chosen.agentId)
  })

  const colourOf = (agentId: string): string => voice(Math.max(0, props.agents.indexOf(agentId)))

  const body: PaintedRow[] = shown.map((notice, at) => ({
    ...(notice.seen ? {} : { background: mix(colourOf(notice.agentId), theme.surface, 0.92) }),
    segments: [
      { text: ` ${at + 1} `, color: theme.faint },
      {
        text: notice.agentId.padEnd(14).slice(0, 14),
        color: colourOf(notice.agentId),
        bold: !notice.seen,
      },
      { text: label(notice, theme), color: weightColour(notice.weight, theme), bold: !notice.seen },
      { text: `  ${notice.text}`, color: notice.seen ? theme.faint : theme.text },
    ],
  }))

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Surface
        width={columns}
        rows={[
          {
            background: headerTint(theme.accent, theme.surface),
            segments: [
              { text: ' notices', color: theme.accent, bold: true },
              {
                text: `   ${props.notices.filter((one) => !one.seen).length} unseen`,
                color: theme.muted,
              },
            ],
          },
          { segments: [] },
        ]}
      />

      <Box flexDirection="column" height={room}>
        <Surface
          width={columns}
          rows={
            body.length > 0
              ? body
              : [
                  {
                    segments: [
                      { text: '  nothing has happened behind your back', color: theme.muted },
                    ],
                  },
                ]
          }
        />
      </Box>

      <Row width={columns} background={mix(theme.faint, theme.surface, 0.55)} left={[]} />
      <Row
        width={columns}
        background={theme.surface}
        left={[{ text: ' ' }, ...wordmark(theme)]}
        right={[
          { text: ' 1-9', color: theme.muted, bold: true },
          { text: ' go to the agent  ', color: theme.faint },
          { text: 'esc', color: theme.muted, bold: true },
          { text: ' back ', color: theme.faint },
        ]}
      />
    </Box>
  )
}

function label(notice: Notice, theme: Theme): string {
  void theme
  const text = LABEL[notice.weight]
  return text === '' ? '' : `  ${text}`
}

function weightColour(weight: Notice['weight'], theme: Theme): string {
  if (weight === 'asking') return theme.warn
  if (weight === 'failed') return theme.bad
  return theme.muted
}
