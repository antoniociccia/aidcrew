/** A least-recently-used cache whose entries expire, on a clock the caller supplies. */
export class Cache<K, V> {
  constructor(
    readonly capacity: number,
    readonly ttlMs: number,
    readonly now: () => number = () => Date.now(),
  ) {}

  get(key: K): V | undefined {
    throw notImplemented('get', key)
  }

  set(key: K, value: V): void {
    throw notImplemented('set', [key, value])
  }

  has(key: K): boolean {
    throw notImplemented('has', key)
  }

  delete(key: K): boolean {
    throw notImplemented('delete', key)
  }

  get size(): number {
    throw notImplemented('size', undefined)
  }
}

function notImplemented(what: string, given: unknown): Error {
  return new Error(`Cache.${what} is not implemented yet (${JSON.stringify(given)})`)
}
