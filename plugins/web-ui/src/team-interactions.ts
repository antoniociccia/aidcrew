/** Points retain journal identity even when multiple messages contain identical text. */
export function interactionPoints(
  messages: readonly { readonly id: string; readonly index: number }[],
  curve: {
    readonly start: { readonly x: number; readonly y: number }
    readonly control: { readonly x: number; readonly y: number }
    readonly end: { readonly x: number; readonly y: number }
  },
) {
  return [...messages]
    .sort((a, b) => a.index - b.index)
    .map((message, index) => {
      const t = (index + 1) / (messages.length + 1)
      const rest = 1 - t
      return {
        id: message.id,
        index: message.index,
        label: index + 1,
        t,
        x: rest * rest * curve.start.x + 2 * rest * t * curve.control.x + t * t * curve.end.x,
        y: rest * rest * curve.start.y + 2 * rest * t * curve.control.y + t * t * curve.end.y,
      }
    })
}
