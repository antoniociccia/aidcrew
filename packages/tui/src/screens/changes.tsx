import type { Revertable } from '@aidcrew/hooks-guard'
import { hunkRows } from '@aidcrew/hooks-guard'
import { Box, Text, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import { Header, Keys, Panel } from '../components/chrome.tsx'
import { Field, TextInput } from '../components/input.tsx'
import { diffTone } from '../theme.ts'
import { useTheme } from '../theme-context.tsx'

/**
 * Everything the team has changed, and the one key that takes a part of it
 * back.
 *
 * The panes show a change as it is made, which is what you watch. This is
 * what you act on: one row per hunk, whoever wrote it, and `x`. Reverting
 * lives here rather than on a pane because a pane is the field you type
 * instructions into — `x` there is the letter x.
 */

export type ChangeRow = {
  /** Which change in the journal, and which of its hunks. */
  at: number
  hunk: number
  agentId: string
  file: string
  /** The job whose checkout it happened in, when it was not the repository. */
  task?: string
  when: number
  added: number
  removed: number
  /** The lines themselves, marked the way a pane marks them. */
  rows: string[]
}

export type ChangesProps = {
  changes: ChangeRow[]
  /** Takes one hunk back, and says what came of it. */
  onRevert(change: ChangeRow, reason: string, anyway: boolean): Promise<string>
  onClose(): void
}

/** What the guard kept, as one row per hunk. */
export function changeRows(all: Revertable[]): ChangeRow[] {
  return all.flatMap((change) =>
    change.hunks.map((hunk, at) => {
      const rows = hunkRows(hunk)
      return {
        at: change.at,
        hunk: at,
        agentId: change.agentId,
        file: change.file,
        ...(change.task === undefined ? {} : { task: change.task }),
        when: change.when,
        added: rows.filter((row) => row.startsWith('+')).length,
        removed: rows.filter((row) => row.startsWith('-')).length,
        rows,
      }
    }),
  )
}

/**
 * The rows of a hunk, each with a name of its own.
 *
 * Two context lines in one hunk can read identically — a pair of closing
 * braces — so a row is named by what it says and by how many rows before it
 * said the same thing. Its position in the list would do as well, until the
 * list changes under it.
 */
function named(rows: string[]): { key: string; text: string }[] {
  const seen = new Map<string, number>()
  return rows.map((text) => {
    const before = seen.get(text) ?? 0
    seen.set(text, before + 1)
    return { key: `${text}#${before}`, text }
  })
}

/** How long ago, in the roughness somebody reads at a glance. */
function since(when: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - when) / 1000))
  if (seconds < 90) return `${seconds}s ago`
  const minutes = Math.round(seconds / 60)
  return minutes < 90 ? `${minutes}m ago` : `${Math.round(minutes / 60)}h ago`
}

export function Changes({ changes, onRevert, onClose }: ChangesProps) {
  const theme = useTheme()
  const window = useWindowSize()
  const [cursor, setCursor] = useState(0)
  const [asking, setAsking] = useState(false)
  const [reason, setReason] = useState('')
  const [said, setSaid] = useState<string | undefined>()
  /**
   * Whether the next `x` means "do it anyway".
   *
   * A refusal because later work would be discarded is not a failure to
   * repeat louder; it is a question. Answering it is pressing the same key
   * again, and the answer is forgotten as soon as the cursor moves.
   */
  const [anyway, setAnyway] = useState(false)

  const selected = changes[Math.min(cursor, changes.length - 1)]

  async function take(change: ChangeRow, why: string): Promise<void> {
    setAsking(false)
    setReason('')
    const outcome = await onRevert(change, why, anyway)
    setSaid(outcome)
    setAnyway(outcome.includes('later change'))
  }

  useInput(
    (input, key) => {
      if (asking) {
        if (key.escape) {
          setAsking(false)
          setReason('')
        }
        return
      }

      if (key.escape) {
        onClose()
        return
      }
      if (input === 'x' && selected) {
        setAsking(true)
        setSaid(undefined)
        return
      }
      if (key.upArrow || input === 'k') {
        setCursor((at) => Math.max(0, at - 1))
        setAnyway(false)
        setSaid(undefined)
      }
      if (key.downArrow || input === 'j') {
        setCursor((at) => Math.min(changes.length - 1, at + 1))
        setAnyway(false)
        setSaid(undefined)
      }
    },
    { isActive: true },
  )

  const now = Date.now()

  return (
    // The window's height exactly: a frame shorter than the window, after one
    // that filled it, makes Ink clear the terminal, and a clear is a blink.
    <Box flexDirection="column" height={window.rows} width={window.columns}>
      <Header title="changes" />

      <Box marginY={1} flexDirection="column">
        {changes.length === 0 ? (
          <Panel title="Nothing to take back" focused>
            <Text color={theme.muted}>
              Nothing has been changed in this session that is not already the way it was.
            </Text>
          </Panel>
        ) : (
          <Panel title={`${changes.length} to take back, newest first`} focused>
            {changes.slice(0, Math.max(3, window.rows - 16)).map((change, at) => (
              <Text
                key={`${change.at}:${change.hunk}`}
                color={at === cursor ? theme.accent : theme.muted}
                bold={at === cursor}
              >
                {at === cursor ? '▸ ' : '  '}
                {change.agentId}
                {change.task === undefined ? '' : ` · ${change.task}`} · {change.file} +
                {change.added} -{change.removed} · {since(change.when, now)}
              </Text>
            ))}
          </Panel>
        )}

        {selected ? (
          <Box marginTop={1} flexDirection="column">
            {named(selected.rows).map((row) => {
              const tone = diffTone(row.text, theme, theme.accent)
              return (
                <Text key={row.key} color={tone.color} {...(tone.bold ? { bold: true } : {})}>
                  {row.text}
                </Text>
              )
            })}
          </Box>
        ) : null}

        {asking && selected ? (
          <Box marginTop={1}>
            <Field label="why (enter to skip)" focused>
              <TextInput
                value={reason}
                onChange={setReason}
                onSubmit={(value) => void take(selected, value.trim())}
                placeholder="the default is missing"
              />
            </Field>
          </Box>
        ) : null}

        {said ? (
          <Box marginTop={1}>
            <Text color={said.includes('later change') ? theme.warn : theme.ok}>{said}</Text>
            {said.includes('later change') ? (
              <Text color={theme.muted}> — x again to do it anyway</Text>
            ) : null}
          </Box>
        ) : null}
      </Box>

      <Box flexGrow={1} />
      <Keys
        keys={[
          ['↑↓', 'move'],
          ['x', anyway ? 'take it back anyway' : 'take it back'],
          ['esc', 'back'],
        ]}
      />
    </Box>
  )
}
