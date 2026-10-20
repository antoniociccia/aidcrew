import type { AgentSnapshot } from '@aidcrew/core'
import { Box, Text } from 'ink'
import { useMemo } from 'react'
import { bubbleLayout, bubbleRows, terminalLabel } from '../bubble-graph.ts'
import { hidePaths } from '../private.ts'
import type { Line } from '../screens/session.tsx'
import { graphEdges } from '../team-graph.ts'
import { TEAM_VIEW_TEXT as T } from '../team-view-text.ts'
import { useTheme } from '../theme-context.tsx'
import { Surface } from './surface.tsx'
import { cutAt } from './text-width.ts'

export function TeamGraph({
  agents,
  lines,
  target,
  width,
  height,
  hidden,
}: {
  agents: AgentSnapshot[]
  lines: Line[]
  target: string
  width: number
  height: number
  hidden: boolean
}) {
  const theme = useTheme()
  const canvasHeight = Math.max(0, height - 3)
  const edges = useMemo(
    () =>
      graphEdges(
        agents.map((agent) => agent.id),
        lines,
      ),
    [agents, lines],
  )
  const canvas = useMemo(() => {
    const nodes = bubbleLayout(agents, target, width, canvasHeight)
    return {
      count: nodes.length,
      rows: bubbleRows(agents, edges, target, width, canvasHeight, nodes),
    }
  }, [agents, edges, target, width, canvasHeight])
  const selected = agents.find((agent) => agent.id === target)
  const latest = lines.findLast((line) => line.agentId === target && line.kind !== 'thinking')
  const detail = hidden
    ? hidePaths(latest?.text ?? selected?.status ?? '')
    : (latest?.text ?? selected?.status ?? '')
  return (
    <Box flexDirection="column" width={width} height={height} overflow="hidden">
      <Text bold color={theme.text}>
        {T.graph} · {canvas.count}/{agents.length} · ●{' '}
        {agents.filter((agent) => agent.status === 'working').length} ·{' '}
        <Text color="#5eead4">{T.outgoing}</Text> <Text color="#c4b5fd">{T.incoming}</Text> · Tab ↔
      </Text>
      <Surface width={width} rows={canvas.rows} />
      <Text color={theme.muted}>
        {
          cutAt(
            terminalLabel(
              `${target} · ${T.role}: ${selected?.role ?? target} · ${T.provider}: ${selected?.provider ?? T.unspecified} · ${T.task}: ${selected?.task ?? 'main'}`,
            ),
            width,
          )[0]
        }
      </Text>
      <Text color={theme.muted}>{cutAt(terminalLabel(detail).replace(/\s+/g, ' '), width)[0]}</Text>
    </Box>
  )
}
