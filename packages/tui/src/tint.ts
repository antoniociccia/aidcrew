/**
 * A colour, quietened until it can sit behind text.
 *
 * An agent's own colour as a background is how you tell, without reading
 * anything, whose work you are looking at. At full strength it drowns the text
 * on top of it, so it is mixed most of the way into the ground first.
 */

/** Blends `colour` toward `ground` — 0 keeps the colour, 1 gives the ground. */
export function mix(colour: string, ground: string, amount: number): string {
  const from = parse(colour)
  const to = parse(ground)
  if (!from || !to) return ground

  const blend = (a: number, b: number): number => Math.round(a + (b - a) * clamp(amount))
  return hex(blend(from[0], to[0]), blend(from[1], to[1]), blend(from[2], to[2]))
}

/**
 * The background a pane gets when it belongs to one agent.
 *
 * Kept faint on purpose: enough to read as "this is theirs" out of the corner
 * of an eye, not enough to compete with what is written on it.
 */
export function paneTint(voice: string, ground: string): string {
  return mix(voice, ground, 0.88)
}

/** The same, a shade stronger, for a header that has to be unmistakable. */
export function headerTint(voice: string, ground: string): string {
  return mix(voice, ground, 0.72)
}

/**
 * An agent's colour turned up, for the tab of one acting without being asked.
 *
 * Still its own colour: which agent this is stays the thing the colour says,
 * and swapping in a warning hue would have made every unsupervised agent look
 * like the same agent. Turned up far enough that the difference is the first
 * thing the eye lands on, rather than something you notice on the second pass.
 */
export function loudTint(voice: string, ground: string): string {
  return mix(voice, ground, 0.28)
}

/**
 * The same colour, lit.
 *
 * For the tab that is both loose and the one being addressed: its ground is
 * already the colour at full strength, so turning it up has to go the other
 * way — toward white — or the tab in front of you would be the one tab that
 * did not change.
 */
export function litTint(voice: string): string {
  return mix(voice, '#ffffff', 0.3)
}

function parse(colour: string): [number, number, number] | undefined {
  const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(colour)
  if (!match) return undefined
  return [
    Number.parseInt(match[1] as string, 16),
    Number.parseInt(match[2] as string, 16),
    Number.parseInt(match[3] as string, 16),
  ]
}

const hex = (r: number, g: number, b: number): string =>
  `#${[r, g, b].map((v) => v.toString(16).padStart(2, '0')).join('')}`

const clamp = (value: number): number => Math.min(1, Math.max(0, value))
