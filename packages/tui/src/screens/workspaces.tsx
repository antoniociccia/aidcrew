import { homedir } from 'node:os'
import { isAbsolute, join, resolve } from 'node:path'
import type { Workspace } from '@aidcrew/cli'
import { Box, Text, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import { Header, Keys, Panel, Problem, Select } from '../components/chrome.tsx'
import { Field, TextInput } from '../components/input.tsx'
import { useTheme } from '../theme-context.tsx'

/**
 * Choosing what to work on.
 *
 * Projects are remembered so that opening the second one is a keystroke rather
 * than a path. Each keeps its own team, its own agent files and its own
 * worktrees; only the keys are shared, because they belong to the person and
 * not to the project.
 */

export type WorkspacesProps = {
  known: Workspace[]
  /** Where a name with no directory in it lands. */
  cwd: string
  home?: string
  /** Why the last project would not open, if one would not. */
  failure?: string
  onOpen(path: string): void
  onForget(path: string): void
  /** Drops every remembered project at once. Touches nothing on disk. */
  onForgetAll(): void
  onCancel?: () => void
  /** Whether a resolved path is already a directory. */
  exists(path: string): boolean
  /** Checks a resolved path before it is accepted. */
  validate(path: string): Promise<{ ok: true } | { ok: false; reason: string }>
  /** Starting state, for tests and for a screen reopened on the add field. */
  initialDraft?: string
  confirmingForgetAll?: boolean
}

type Mode = 'pick' | 'add'

/**
 * The directory a typed name means.
 *
 * Naming a project used to mean typing an absolute path to a directory that
 * already existed, which puts two chores in front of the thing you wanted:
 * work out where you are, and go and make it first. A bare name is now a
 * directory beside the one you started aidcrew in, which is where somebody
 * typing a name is nearly always pointing.
 *
 * Absolute paths and `~` still mean what they always mean — this is a
 * shorthand for the common case, not a new rule about paths.
 */
export function projectPath(typed: string, cwd: string, home = homedir()): string | undefined {
  const trimmed = typed.trim()
  if (trimmed === '') return undefined

  if (trimmed === '~') return home
  if (trimmed.startsWith('~/')) return join(home, trimmed.slice(2))
  if (isAbsolute(trimmed)) return resolve(trimmed)

  return resolve(cwd, trimmed)
}

export function Workspaces({
  known,
  cwd,
  home,
  failure,
  onOpen,
  onForget,
  onForgetAll,
  onCancel,
  exists,
  validate,
  initialDraft = '',
  confirmingForgetAll = false,
}: WorkspacesProps) {
  const theme = useTheme()
  const window = useWindowSize()
  const [mode, setMode] = useState<Mode>(known.length === 0 ? 'add' : 'pick')
  const [draft, setDraft] = useState(initialDraft)
  const [problem, setProblem] = useState<string | undefined>()
  const [cursor, setCursor] = useState(0)
  const [confirming, setConfirming] = useState(confirmingForgetAll)

  const resolved = projectPath(draft, cwd, home)
  const isNew = resolved !== undefined && !exists(resolved)

  async function accept(typed: string): Promise<void> {
    const path = projectPath(typed, cwd, home)
    if (path === undefined) return

    const verdict = await validate(path)
    if (!verdict.ok) {
      setProblem(verdict.reason)
      return
    }
    onOpen(path)
  }

  useInput(
    (input, key) => {
      if (confirming) {
        // Typed rather than a single key: forgetting the whole list is not a
        // keystroke you should be able to make by leaning on the keyboard.
        if (input === 'y') {
          onForgetAll()
          setConfirming(false)
          setCursor(0)
        }
        if (key.escape || input === 'n') setConfirming(false)
        return
      }

      if (mode === 'pick') {
        if (input === 'a') {
          setMode('add')
          setProblem(undefined)
          return
        }
        if (input === 'd') {
          const target = known[cursor]
          if (target) onForget(target.path)
          return
        }
        if (input === 'D' && known.length > 0) {
          setConfirming(true)
          return
        }
        if (key.upArrow) setCursor((c) => Math.max(0, c - 1))
        if (key.downArrow) setCursor((c) => Math.min(known.length - 1, c + 1))
        if (key.escape && onCancel) onCancel()
        return
      }

      if (key.escape) {
        if (known.length > 0) setMode('pick')
        else if (onCancel) onCancel()
      }
    },
    { isActive: true },
  )

  return (
    // The window's height exactly, padded rather than short. Ink erases the
    // previous frame and writes this one — but a frame shorter than the window,
    // following one that filled it, makes it clear the whole terminal instead,
    // and a clear is the blink people see when a screen opens.
    <Box flexDirection="column" height={window.rows} width={window.columns}>
      <Header title="projects" />

      <Box marginY={1}>
        {confirming ? (
          <Panel title={`Forget all ${known.length} projects?`} focused>
            <Text color={theme.text}>
              This forgets the list only. Nothing on disk is touched — every project is still there,
              and opening one again remembers it again.
            </Text>
          </Panel>
        ) : mode === 'pick' ? (
          <Panel title="Open a project" focused>
            <Select
              choices={known.map((workspace) => ({
                value: workspace.path,
                label: workspace.name,
                hint: workspace.path,
              }))}
              onChoose={(path) => void accept(path)}
            />
            {failure ? (
              <Box marginTop={1}>
                <Problem text={failure} />
              </Box>
            ) : null}
          </Panel>
        ) : (
          <Panel title="Name it, or give a path" focused>
            <Field label="project" focused>
              <TextInput
                value={draft}
                onChange={(value) => {
                  setDraft(value)
                  setProblem(undefined)
                }}
                onSubmit={(value) => void accept(value)}
                placeholder="inventory"
              />
            </Field>

            {/* Where a name lands, said while it is being typed rather than
                after it has been accepted: "inventory" answers nothing about
                which directory that is, and the answer is the whole question. */}
            {resolved ? (
              <Box marginTop={1}>
                <Text color={theme.muted}>
                  {resolved}
                  {isNew ? <Text color={theme.warn}> — will be created</Text> : null}
                </Text>
              </Box>
            ) : null}

            {problem ? (
              <Box marginTop={1}>
                <Problem text={problem} />
              </Box>
            ) : (
              <Box marginTop={1}>
                <Text color={theme.muted}>
                  A git repository is best: agents get their own worktree and cannot collide.
                </Text>
              </Box>
            )}
          </Panel>
        )}
      </Box>

      <Keys
        keys={
          confirming
            ? [
                ['y', 'forget them all'],
                ['n / esc', 'keep them'],
              ]
            : mode === 'pick'
              ? [
                  ['↑↓', 'move'],
                  ['enter', 'open'],
                  ['a', 'add another'],
                  ['d', 'forget'],
                  ['D', 'forget all'],
                ]
              : [
                  ['enter', isNew ? 'create and open' : 'open'],
                  ['esc', known.length > 0 ? 'back' : 'quit'],
                ]
        }
      />
    </Box>
  )
}
