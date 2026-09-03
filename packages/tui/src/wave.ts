/**
 * An agent's recent activity as one line of blocks.
 *
 * Eight heights per cell is enough to show a rhythm — bursts, stalls, steady
 * work — and one row is cheap enough to give every agent its own. The shape is
 * what you read first: who is pushing, who stopped, who never started.
 */
const BARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const

export function wave(samples: number[], width: number): string {
  if (width <= 0) return ''

  // Right-aligned: the present is the end of the line, and a short history
  // should not stretch to fill space it has not earned.
  const recent = samples.slice(-width)
  const max = Math.max(...recent, 1)

  const drawn = recent
    .map((value) => BARS[Math.min(7, Math.round((value / max) * 7))] ?? BARS[0])
    .join('')

  return drawn.padStart(width, BARS[0])
}

/**
 * Folds a running count into fixed-width history.
 *
 * Called once per tick with whatever happened since the last one, so the line
 * scrolls rather than growing.
 */
export function push(history: number[], value: number, width: number): number[] {
  return [...history, value].slice(-width)
}
