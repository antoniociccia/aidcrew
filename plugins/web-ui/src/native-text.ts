/** English catalog for the embedded native terminal. */
export const nativeText = {
  tab: 'Native terminal',
  reconnect: 'Connect / reconnect',
  detach: 'Detach',
  stop: 'Stop native agent',
  permissions: 'Native permissions',
  unreportedUsage: 'Excludes native Claude usage',
  permissionHelp:
    'Claude Code manages native tool permissions. AIDCrew guards cover only shared MCP tools.',
  context:
    'Same agent, task and Claude Code session. Native commands and permissions are handled by Claude Code.',
  connecting: 'Connecting to the native terminal…',
  connected: 'Native terminal connected',
  disconnected: 'Terminal detached. Open it again to reconnect.',
  invalidFrame: 'The native terminal returned an unsupported message.',
  connectionError: 'Could not connect to the native terminal. Open it again to retry.',
  authenticationRequired: 'Connect to your AIDCrew session before opening the native terminal.',
  outputUnavailable: 'Terminal output could not be displayed.',
  label: 'Native Claude Code terminal',
  stopped: (code: number | null) =>
    code === null ? 'Native terminal exited.' : `Native terminal exited with code ${code}.`,
}
