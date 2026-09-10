/** Detect a page-reported rejection repeated despite changes to unrelated telemetry. */
export class BrowserProgress {
  #turns = new WeakMap<AbortSignal, Map<unknown, { key: string; count: number }>>()

  record(signal: AbortSignal, page: unknown, content: string): string | undefined {
    let pages = this.#turns.get(signal)
    if (!pages) {
      pages = new Map()
      this.#turns.set(signal, pages)
    }
    let value: unknown
    try {
      value = JSON.parse(content.match(/```json\s*([\s\S]*?)```/)?.[1] ?? content)
    } catch {
      return undefined
    }
    if (!value || typeof value !== 'object' || !('after' in value)) return undefined
    const after = value.after
    if (!after || typeof after !== 'object' || !('status' in after)) return undefined
    if (
      typeof after.status !== 'string' ||
      !/✕|✗|❌|\b(?:rejected|denied)\b|^(?:status:\s*)?(?:error|failed|blocked|invalid)\b/i.test(
        after.status,
      )
    ) {
      pages.delete(page)
      return undefined
    }
    // Only explicit action feedback is compared. Camera telemetry elsewhere in
    // the result must not turn the same rejected action into apparent progress.
    const key = JSON.stringify(
      Object.fromEntries(Object.entries(after).sort(([a], [b]) => a.localeCompare(b))),
    )
    const previous = pages.get(page)
    const count = previous?.key === key ? previous.count + 1 : 1
    pages.set(page, { key, count })
    if (count < 6) return undefined
    return 'Browser action repeated the same reported rejection six times without progress. Stop this attempt; change approach or hand the blocker to the coordinating agent.'
  }
}
