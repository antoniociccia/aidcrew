export const paletteText = {
  title: 'Command palette',
  placeholder: 'Find an action or agent…',
  empty: 'No matching actions. Try another search.',
  hint: '↑ ↓ Navigate · Enter Select · Esc Close',
  close: 'Close command palette',
  results: (count: number) => `${count} ${count === 1 ? 'action' : 'actions'} available`,
} as const
