import { Box, Text, useInput, useWindowSize } from 'ink'
import { useState } from 'react'
import { Header, Keys, Panel } from '../components/chrome.tsx'
import { useTheme } from '../theme-context.tsx'

/**
 * What this program is, in the order somebody meets it.
 *
 * A first run used to end at a session with a cursor in it: the team was
 * made, and nothing had said what a team was for, what happens when two
 * agents want the same file, or where the work goes. Everything here is
 * written somewhere — the README, `/help`, the board of keys — and all three
 * are places you go once you already know what you are looking for.
 *
 * Eight pages, because that is what fits before somebody presses escape:
 * what it is, who is on it, how you ask, how they hand work over, where the
 * work goes, how you stop it, what it costs, and where to go next. Reachable
 * afterwards with `/tour`, since the run where you need it is rarely the
 * first one.
 */

export type Page = {
  title: string
  /** One idea per line. The lines are read; a paragraph is skimmed. */
  body: string[]
  /** Keys this page is about, shown as they appear in the tray. */
  keys?: [string, string][]
}

export const PAGES: Page[] = [
  {
    title: 'A team, not an assistant',
    body: [
      'Several coding agents at once, each on its own service and its own model,',
      'all on one screen. Planning on a strong model and doing the work on a cheap',
      'one is the point: it is how the bill stays affordable, and it only works if',
      'two agents can hold two credentials on two services in one session.',
      '',
      'Everything is a plugin — the services, the tools, the guards. The core knows',
      'none of them by name, which is what lets you add your own.',
    ],
  },
  {
    title: 'Who is on the team',
    body: [
      'Each agent is a file: what it is for, and which tools it may use. They live',
      'in .aidcrew/agents and travel with the repository, so whoever clones it gets',
      'the same team.',
      '',
      'Which of them are on this team, and what each one runs on, is',
      '.aidcrew/config.toml. Change a model without restarting anything.',
    ],
    keys: [
      ['^e', 'add, remove or re-model an agent'],
      ['/model', 'move the agent you are talking to'],
      ['/spawn', 'start another of a role, mid-session'],
    ],
  },
  {
    title: 'Asking for work',
    body: [
      'Type at the agent whose pane you are in. Tab moves between them, and so',
      'does clicking a tab.',
      '',
      'Naming a file with @ sends the file, not the name: the agent reads it',
      'without spending a turn going to find it.',
    ],
    keys: [
      ['tab', 'another agent'],
      ['@path', 'send a file with the message'],
      ['^t', 'find a file by part of its name'],
      ['^l', 'show two agents side by side'],
    ],
  },
  {
    title: 'How they work together',
    body: [
      'An agent hands work on with agent_send rather than stopping to ask you.',
      'Every job reports back to the leader, which is the one agent always on the',
      'team, and the leader is what brings the work home.',
      '',
      'How the team works — hand it on rather than ask, what a handoff carries,',
      'what counts as finished — is one file: ORCHESTRATE.md. Without one they use',
      'the wording built in.',
    ],
  },
  {
    title: 'Where the work goes',
    body: [
      'Every job gets a git worktree of its own, shared by the agents on it. The',
      'checkout you are sitting in is never touched, and two jobs at once are two',
      'diffs rather than one corrupted file.',
      '',
      'A checkout with work in it outlives the session: close the terminal with',
      'files changed and the next session picks it up where it was left.',
    ],
    keys: [
      ['^k', 'the jobs this repository has open'],
      ['/task', 'start one, with its own agents'],
      ['/diff', 'what an agent has changed'],
      ['aidcrew undo', 'take back the last change any of them made'],
    ],
  },
  {
    title: 'Watching, and not watching',
    body: [
      'Anything that writes a file or runs a command is asked about first, in the',
      'pane of the agent that wants it. Turn an agent loose and it stops asking —',
      'for this session only, and the hard guards still hold.',
      '',
      'A turn that runs away costs you the turn, not the agent: escape stops what',
      'it is doing and leaves everything it has done.',
    ],
    keys: [
      ['esc', 'stop the turn, keep the agent'],
      ['/yolo', 'let this one act without asking'],
      ['^x', 'drop what is queued behind the turn'],
    ],
  },
  {
    title: 'What it is costing',
    body: [
      'The row at the foot says how many tokens the session has moved and what',
      'that came to. On a subscription it says how much of the plan is gone and',
      'when it comes back instead, because a price per token is the wrong',
      'question for a plan.',
      '',
      'A figure with a ~ in front is an estimate from a bundled price list. A',
      'blank means nobody has published a price — which is not the same as free.',
    ],
  },
  {
    title: 'That is the whole of it',
    body: [
      'The rest is discoverable: every key is on one board, every command is in',
      '/help, and both are one keystroke away.',
      '',
      'This tour is /tour whenever you want it again.',
    ],
    keys: [
      ['^o', 'every key there is'],
      ['/help', 'every command'],
      ['^c', 'clear the line, or quit on an empty one'],
    ],
  },
]

export function Tour({ onClose, pages = PAGES }: { onClose(): void; pages?: Page[] }) {
  const theme = useTheme()
  const window = useWindowSize()
  const [at, setAt] = useState(0)
  const page = pages[at] ?? pages[0]

  useInput((input, key) => {
    if (key.escape || input === 'q') return onClose()
    if (key.leftArrow || key.upArrow) return setAt((one) => Math.max(0, one - 1))
    // Enter goes forward, and off the end it closes: a tour you have to escape
    // from is a tour that ends by being interrupted.
    if (key.return || key.rightArrow || key.downArrow || input === ' ') {
      if (at >= pages.length - 1) return onClose()
      setAt((one) => Math.min(pages.length - 1, one + 1))
    }
  })

  return (
    // The window's height exactly. A frame shorter than the window, following
    // one that filled it, makes Ink clear the terminal — and a clear is the
    // blink people see when a screen opens.
    <Box flexDirection="column" height={window.rows} width={window.columns}>
      <Header title="tour" subtitle={`${at + 1} of ${pages.length}`} />

      <Box marginY={1} flexGrow={1}>
        <Panel title={page?.title ?? ''} focused>
          {(page?.body ?? []).map((row, index) => (
            <Text
              // biome-ignore lint/suspicious/noArrayIndexKey: prose rows have no id but never move
              key={index}
              color={row === '' ? theme.surface : theme.text}
            >
              {row === '' ? ' ' : row}
            </Text>
          ))}

          {page?.keys ? (
            <Box marginTop={1} flexDirection="column">
              {page.keys.map(([key, what]) => (
                <Text key={key}>
                  <Text color={theme.accent} bold>
                    {key.padEnd(14)}
                  </Text>
                  <Text color={theme.muted}>{what}</Text>
                </Text>
              ))}
            </Box>
          ) : null}
        </Panel>
      </Box>

      <Keys
        keys={[
          ['enter', at >= pages.length - 1 ? 'start' : 'next'],
          ['←', 'back'],
          ['esc', 'skip'],
        ]}
      />
    </Box>
  )
}
