import { Box, Text, useInput } from 'ink'
import type React from 'react'
import { useEffect, useState } from 'react'
import { wordmark } from '../logo.ts'
import { MARK, SPINNER } from '../theme.ts'
import { useTheme } from '../theme-context.tsx'
import { windowAround } from './select-window.ts'

/**
 * A filled band across the screen.
 *
 * Regions are separated by contrast rather than by drawn borders: a band costs
 * one row where a box costs two and a great deal of line noise, and it reads
 * as a surface rather than as a diagram of one.
 */
export function Band({
  children,
  columns,
  ...rest
}: {
  children: React.ReactNode
  columns?: number
  [key: string]: unknown
}) {
  const theme = useTheme()

  return (
    <Box
      {...(theme.fill === 'hairline' ? {} : { backgroundColor: theme.surface })}
      paddingX={1}
      justifyContent="space-between"
      {...(columns ? { width: columns } : {})}
      {...rest}
    >
      {children}
    </Box>
  )
}

/** The bar at the top of every screen: what this is, and where you are. */
export function Header({
  title,
  subtitle,
  columns,
}: {
  title: string
  subtitle?: string | undefined
  columns?: number | undefined
}) {
  const theme = useTheme()

  return (
    <Band {...(columns ? { columns } : {})}>
      <Text>
        {wordmark(theme).map((segment, at) => (
          <Text
            // biome-ignore lint/suspicious/noArrayIndexKey: the mark is a fixed list of letters, so the position is the identity
            key={at}
            {...(segment.bold ? { bold: true } : {})}
            {...(segment.color ? { color: segment.color } : {})}
            {...(segment.background ? { backgroundColor: segment.background } : {})}
          >
            {segment.text}
          </Text>
        ))}
        <Text color={theme.muted}>
          {'   '}
          {title}
        </Text>
      </Text>
      {subtitle ? <Text color={theme.muted}>{subtitle}</Text> : <Text> </Text>}
    </Band>
  )
}

/**
 * What you can press, right now.
 *
 * Always on screen rather than behind a help key. An interface you have to be
 * taught is an interface people use a third of.
 */
export function Keys({ keys }: { keys: [string, string][] }) {
  const theme = useTheme()

  return (
    <Box paddingX={1} gap={2}>
      {keys.map(([key, label]) => (
        <Text key={key}>
          <Text color={theme.accent}>{key}</Text>
          <Text color={theme.faint}> {label}</Text>
        </Text>
      ))}
    </Box>
  )
}

/** A titled region, filled rather than boxed. */
export function Panel({
  title,
  focused = false,
  children,
  ...rest
}: {
  title?: string
  focused?: boolean
  children: React.ReactNode
  [key: string]: unknown
}) {
  const theme = useTheme()

  return (
    <Box flexDirection="column" paddingX={1} {...rest}>
      {title ? (
        <Box marginBottom={1}>
          <Text bold color={focused ? theme.accent : theme.muted}>
            {title}
          </Text>
        </Box>
      ) : null}
      {children}
    </Box>
  )
}

/** Turns while something is happening. */
export function Spinner({ label }: { label?: string | undefined }) {
  const theme = useTheme()
  const [frame, setFrame] = useState(0)

  useEffect(() => {
    const timer = setInterval(() => setFrame((current) => current + 1), 80)
    return () => clearInterval(timer)
  }, [])

  return (
    <Text color={theme.accent}>
      {SPINNER[frame % SPINNER.length]}
      {label ? <Text color={theme.muted}> {label}</Text> : null}
    </Text>
  )
}

/** Something went wrong, said plainly, with what to do about it. */
export function Problem({ text, hint }: { text: string; hint?: string | undefined }) {
  const theme = useTheme()

  return (
    <Box flexDirection="column">
      <Text color={theme.bad}>{text}</Text>
      {hint ? <Text color={theme.muted}>{hint}</Text> : null}
    </Box>
  )
}

export type Choice<T> = {
  value: T
  label: string
  /** Shown beside the label, for the thing you need to choose well. */
  hint?: string | undefined
}

/**
 * A list you move through.
 *
 * The selected row is filled rather than marked with an arrow, and long lists
 * scroll within a window instead of running off the bottom of the terminal —
 * which is what turned a list of sixty models into a list of the first twelve.
 */
export function Select<T>({
  choices,
  onChoose,
  onCancel,
  isActive = true,
  height = 12,
}: {
  choices: Choice<T>[]
  onChoose: (value: T) => void
  onCancel?: () => void
  isActive?: boolean
  height?: number
}) {
  const theme = useTheme()
  const [cursor, setCursor] = useState(0)
  const bounded = Math.min(cursor, Math.max(0, choices.length - 1))

  useInput(
    (input, key) => {
      if (key.upArrow || input === 'k') setCursor((c) => Math.max(0, c - 1))
      if (key.downArrow || input === 'j') setCursor((c) => Math.min(choices.length - 1, c + 1))
      if (key.pageUp) setCursor((c) => Math.max(0, c - height))
      if (key.pageDown) setCursor((c) => Math.min(choices.length - 1, c + height))
      if (input === 'g') setCursor(0)
      if (input === 'G') setCursor(choices.length - 1)
      if (key.return) {
        const chosen = choices[bounded]
        if (chosen) onChoose(chosen.value)
      }
      if (key.escape && onCancel) onCancel()
    },
    { isActive },
  )

  if (choices.length === 0) {
    return <Text color={theme.muted}>nothing here yet</Text>
  }

  const { start, end } = windowAround(bounded, choices.length, height)

  return (
    <Box flexDirection="column">
      {start > 0 ? <Text color={theme.faint}>{`  ${start} above`}</Text> : null}

      {choices.slice(start, end).map((choice, offset) => {
        const selected = start + offset === bounded
        return (
          <Box
            key={choice.label}
            justifyContent="space-between"
            {...(selected && theme.fill !== 'hairline' ? { backgroundColor: theme.surface } : {})}
          >
            {/* A row is one row. Left to itself the pair wrapped rather than
                fitting: a project called `aidcrew-demo-Ochvf6` in a temporary
                directory drew as `aidcrew-demo-Och` / `f6` across two lines,
                with its path broken over two more — four lines of which none
                is readable, for one entry in a list.

                The name never gives way, because it is what you are choosing
                between. The path gives way from its front, because the end of
                a path is the part that distinguishes it: `…/T/aidcrew-demo`
                answers the question and `/private/var/folders/n0/s61…` does
                not. */}
            {/* Which row you are on was said by the fill alone. Unfilled that
                leaves bold and an accent, which is not enough to find at a
                glance — so the mark every other list uses says it here too. */}
            <Text color={selected ? theme.accent : theme.text} bold={selected} wrap="truncate-end">
              {theme.fill === 'hairline' ? (selected ? MARK.selected : ' ') : ' '}
              {choice.label}
            </Text>
            <Text color={selected ? theme.muted : theme.faint} wrap="truncate-start">
              {choice.hint ? `  ${choice.hint} ` : ' '}
            </Text>
          </Box>
        )
      })}

      {end < choices.length ? (
        <Text color={theme.faint}>{`  ${choices.length - end} below`}</Text>
      ) : null}
    </Box>
  )
}
