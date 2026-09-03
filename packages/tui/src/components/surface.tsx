import { Text } from 'ink'
import type { PaintedRow } from './paint.ts'
import { paint } from './paint.ts'
import type { Segment } from './row.ts'
import { coalesce, compose } from './row.ts'

/**
 * A block of rows, drawn as one thing.
 *
 * Each row is padded to the full width so the tint reaches the edge — a
 * background that stops where the text stops reads as a highlight rather than
 * as a surface — and the whole block becomes a single string, because asking
 * Ink to lay out one element per row cost more than everything else the
 * interface does put together.
 */
export function Surface({ width, rows }: { width: number; rows: PaintedRow[] }) {
  const painted = paint(
    rows.map((one) => ({
      ...one,
      segments: coalesce(compose(width, one.segments)),
    })),
  )

  return <Text wrap="truncate-end">{painted}</Text>
}

/** One row, for the places that are genuinely one row. */
export function Row({
  width,
  background,
  left,
  right,
  fill,
  fillBackground,
}: {
  width: number
  background?: string | undefined
  left: Segment[]
  right?: Segment[]
  fill?: number | undefined
  fillBackground?: string | undefined
}) {
  return (
    <Surface width={width} rows={[row(width, background, left, right, fill, fillBackground)]} />
  )
}

/**
 * Builds one row for a surface, splitting the background when part of it is
 * filled — a share of the work drawn as how far the colour reaches, rather
 * than as a bar taking a row of its own.
 */
export function row(
  width: number,
  background: string | undefined,
  left: Segment[],
  right: Segment[] = [],
  fill?: number | undefined,
  fillBackground?: string | undefined,
): PaintedRow {
  return {
    ...(background ? { background } : {}),
    segments: compose(width, left, right),
    ...(fill !== undefined && fillBackground !== undefined ? { fill, fillBackground } : {}),
  }
}

/** Blank rows, to carry a surface down past its content. */
export function blanks(height: number, background?: string | undefined): PaintedRow[] {
  return Array.from({ length: Math.max(0, height) }, () => ({
    ...(background ? { background } : {}),
    segments: [],
  }))
}
