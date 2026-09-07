export type Listener = (payload: unknown) => void

/** Listeners by event name; emit calls each one with the payload. */
export class Emitter {
  #listeners = new Map<string, Listener[]>()

  on(event: string, listener: Listener): void {
    const list = this.#listeners.get(event) ?? []
    list.push(listener)
    this.#listeners.set(event, list)
  }

  once(event: string, listener: Listener): void {
    const wrapped: Listener = (payload) => {
      this.off(event, wrapped)
      listener(payload)
    }
    this.on(event, wrapped)
  }

  off(event: string, listener: Listener): boolean {
    const list = this.#listeners.get(event)
    if (!list) return false
    const at = list.indexOf(listener)
    if (at < 0) return false
    list.splice(at, 1)
    return true
  }

  emit(event: string, payload?: unknown): number {
    const list = this.#listeners.get(event) ?? []
    let called = 0
    for (let at = 0; at < list.length; at++) {
      list[at]?.(payload)
      called += 1
    }
    return called
  }
}
