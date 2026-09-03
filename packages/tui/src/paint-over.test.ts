import { describe, expect, test } from 'bun:test'
import { paintOver, repaint } from './paint-over.ts'

const ESC = '\u001b'
/** What Ink writes before a frame: erase a line, climb one, and so on, then erase and return. */
const erasing = (lines: number) => `${`${ESC}[2K${ESC}[1A`.repeat(lines - 1)}${ESC}[2K${ESC}[G`

describe('drawing a frame over the last one instead of after wiping it', () => {
  test('climbs to the top without erasing on the way up', () => {
    // Ink wipes every row of the previous frame and then writes the new one.
    // A terminal that paints between the two — one that does not buffer a
    // synchronised update, and there are several — shows the wipe: a black
    // screen with the first rows of the new frame on it, for one frame.
    const frame = `${erasing(3)}one\ntwo\nthree`

    const drawn = repaint(frame)

    expect(drawn.startsWith(`${ESC}[2A${ESC}[G`)).toBe(true)
    expect(drawn).not.toContain(`${ESC}[2K`)
  })

  test('erases to the right of every line, so a shorter line leaves nothing of the longer one under it', () => {
    const drawn = repaint(`${erasing(2)}short\nlonger line`)

    expect(drawn).toContain(`short${ESC}[K\n`)
    expect(drawn).toContain(`longer line${ESC}[K`)
  })

  test('clears below the last line, so a shorter frame leaves no stale rows', () => {
    const drawn = repaint(`${erasing(4)}one\ntwo`)

    expect(drawn.endsWith(`two${ESC}[K${ESC}[J`)).toBe(true)
  })

  test('keeps the rows themselves exactly as Ink drew them', () => {
    const rows = [`${ESC}[1mbold${ESC}[22m`, ' spaced  ', '']
    const drawn = repaint(`${erasing(3)}${rows.join('\n')}`)

    expect(drawn).toBe(`${ESC}[2A${ESC}[G${rows.map((row) => `${row}${ESC}[K`).join('\n')}${ESC}[J`)
  })

  test('leaves alone anything that is not a frame drawn over a previous one', () => {
    // The first frame has nothing above it; a full clear is Ink recovering
    // from an overflow; the rest is cursor work and the synchronised-update
    // brackets. None of these is the wipe, and none should be touched.
    for (const chunk of [
      'first frame\nwith no erase',
      `${ESC}[2J${ESC}[3J${ESC}[Hafter an overflow`,
      `${ESC}[?2026h`,
      `${ESC}[?2026l`,
      `${ESC}[3A${ESC}[10G`,
      `${ESC}[?25l`,
    ]) {
      expect(repaint(chunk)).toBe(chunk)
    }
  })
})

describe('the stream Ink is handed', () => {
  test('answers for the terminal and rewrites only what it writes', () => {
    const written: string[] = []
    const real = {
      rows: 40,
      columns: 100,
      isTTY: true,
      write(chunk: string | Uint8Array) {
        written.push(typeof chunk === 'string' ? chunk : new TextDecoder().decode(chunk))
        return true
      },
      on() {
        return this
      },
      off() {
        return this
      },
    }

    const stream = paintOver(real as never)
    stream.write(`${erasing(2)}a\nb`)

    expect(stream.rows).toBe(40)
    expect(stream.columns).toBe(100)
    expect(stream.isTTY).toBe(true)
    expect(written).toEqual([`${ESC}[1A${ESC}[Ga${ESC}[K\nb${ESC}[K${ESC}[J`])
  })
})
