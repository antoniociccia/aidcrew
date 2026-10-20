/** English content for terminal transcript search and its command entry. */
export const SEARCH_TEXT = {
  title: 'Search',
  empty: 'No matches',
  emptyDetail: 'No matches in this agent’s transcript.',
  navigation: '↑ ↓ previous / next · esc back',
  commandArgs: '<text>',
  commandDescription: 'Search this agent’s transcript; arrows browse matches, Esc returns.',
  browserHint:
    'Use the browser search field or press F outside the composer to search the conversation.',
  terminalOnly: 'This presentation command is available in the terminal only.',
  position: (current: number, total: number, kind: string): string =>
    `${current} of ${total} · ${kind} · newest first`,
  kinds: {
    ask: 'ask',
    say: 'say',
    tool: 'tool',
    error: 'error',
    note: 'note',
    thinking: 'thinking',
    diff: 'diff',
  },
} as const
