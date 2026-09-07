/** A least-recently-used cache whose entries expire, on a clock the caller supplies. */
export class Cache<K, V> {
  // Insertion order is recency: a use deletes and re-inserts.
  #entries = new Map<K, { value: V; expiresAt: number }>()

  constructor(
    readonly capacity: number,
    readonly ttlMs: number,
    readonly now: () => number = () => Date.now(),
  ) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`capacity must be 1 or more, got ${capacity}`)
    }
  }

  get(key: K): V | undefined {
    const entry = this.#live(key)
    if (!entry) return undefined
    this.#entries.delete(key)
    this.#entries.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    this.#entries.delete(key)
    this.#sweep()
    while (this.#entries.size >= this.capacity) {
      const oldest = this.#entries.keys().next().value
      if (oldest === undefined) break
      this.#entries.delete(oldest)
    }
    this.#entries.set(key, { value, expiresAt: this.now() + this.ttlMs })
  }

  has(key: K): boolean {
    return this.#live(key) !== undefined
  }

  delete(key: K): boolean {
    const live = this.#live(key) !== undefined
    this.#entries.delete(key)
    return live
  }

  get size(): number {
    this.#sweep()
    return this.#entries.size
  }

  #live(key: K): { value: V; expiresAt: number } | undefined {
    const entry = this.#entries.get(key)
    if (!entry) return undefined
    if (entry.expiresAt <= this.now()) {
      this.#entries.delete(key)
      return undefined
    }
    return entry
  }

  #sweep(): void {
    const at = this.now()
    for (const [key, entry] of this.#entries) {
      if (entry.expiresAt <= at) this.#entries.delete(key)
    }
  }
}
