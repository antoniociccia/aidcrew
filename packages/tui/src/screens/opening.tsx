import { Box, useWindowSize } from 'ink'
import { Panel, Spinner } from '../components/chrome.tsx'

/**
 * The moment between choosing a project and seeing its team.
 *
 * The window's height exactly, like every other screen: a frame shorter than
 * the window, following one that filled it, makes Ink clear the terminal, and
 * a clear is the blink people see. This one sits between two full screens, so
 * short it blinked on the way in and again on the way out.
 */
export function Opening() {
  const window = useWindowSize()

  return (
    <Box padding={1} height={window.rows} width={window.columns}>
      <Panel>
        <Spinner label="opening" />
      </Panel>
    </Box>
  )
}
