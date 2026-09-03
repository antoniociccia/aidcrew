import type { Task } from '@aidcrew/core'
import { describeTask } from '@aidcrew/core'
import { Box, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import { windowAround } from '../components/select-window.ts'
import { Surface } from '../components/surface.tsx'
import { useTheme, useVoice } from '../theme-context.tsx'
import { headerTint, mix } from '../tint.ts'

/**
 * The jobs this repository has open, and which one to work in.
 *
 * A worktree outlives the session that made it: closing a terminal with work
 * in one leaves that work on disk, and without somewhere to see them the only
 * way to find it again is to remember the name. This is that place.
 *
 * The repository itself is on the list because working there is a legitimate
 * choice — the one people make for a small change — and leaving it out would
 * make it the option nobody can see.
 */

export type TasksProps = {
  tasks: Task[]
  /** The one being worked in now, so the list says where you are. */
  current: string
  /** What each job has cost so far, already written for the screen. */
  spentOn?(task: string): string | undefined
  onChoose(name: string): void
  onNew(): void
  onClose(): void
  rows?: number
  columns?: number
}

export function Tasks(props: TasksProps) {
  const theme = useTheme()
  const voice = useVoice()
  const window = useWindowSize()
  const rows = props.rows ?? window.rows
  const columns = props.columns ?? window.columns

  const [cursor, setCursor] = useState(
    Math.max(
      0,
      props.tasks.findIndex((task) => task.name === props.current),
    ),
  )

  useInput((input, key) => {
    if (key.escape) return props.onClose()
    if (key.upArrow) return setCursor((at) => Math.max(0, at - 1))
    if (key.downArrow) return setCursor((at) => Math.min(props.tasks.length - 1, at + 1))
    if (key.return) {
      const chosen = props.tasks[cursor]
      if (chosen) props.onChoose(chosen.name)
      return
    }
    if (input === 'n') props.onNew()
  })

  const room = Math.max(3, rows - 5)
  const shown = windowAround(cursor, props.tasks.length, room)

  return (
    <Box flexDirection="column" height={rows} width={columns}>
      <Surface
        width={columns}
        rows={[
          {
            background: headerTint(theme.accent, theme.surface),
            segments: [
              { text: ' tasks', color: theme.accent, bold: true },
              {
                text: '   a checkout each, so two jobs cannot spoil each other',
                color: theme.muted,
              },
            ],
          },
          ...props.tasks.slice(shown.start, shown.end).map((task, at) => {
            const selected = shown.start + at === cursor
            const here = task.name === props.current
            const colour = voice(shown.start + at)

            return {
              background: selected ? mix(colour, theme.surface, 0.62) : theme.surface,
              segments: [
                { text: selected ? ' ▸ ' : '   ', color: colour },
                {
                  text: task.name.padEnd(18),
                  color: selected ? theme.text : colour,
                  bold: selected,
                },
                // Where you are now, said plainly: a list of jobs that does
                // not say which one you are in is a list you have to count.
                { text: here ? 'here  ' : '      ', color: theme.ok },
                { text: describeTask(task), color: task.changed > 0 ? theme.warn : theme.muted },
                // What the job has cost, which is the other thing somebody
                // deciding where to work wants to know.
                ...(props.spentOn?.(task.name)
                  ? [{ text: `   ${props.spentOn(task.name)}`, color: theme.faint }]
                  : []),
              ],
            }
          }),
          {
            background: theme.surface,
            segments: [
              { text: '   ↑↓', color: theme.faint },
              { text: ' move   ', color: theme.faint },
              { text: 'enter', color: theme.accent, bold: true },
              { text: ' work here   ', color: theme.faint },
              { text: 'n', color: theme.accent, bold: true },
              { text: ' new task   ', color: theme.faint },
              { text: 'esc', color: theme.faint },
              { text: ' back', color: theme.faint },
            ],
          },
        ]}
      />
    </Box>
  )
}
