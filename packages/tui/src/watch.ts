import type { FSWatcher } from 'node:fs'
import { watch } from 'node:fs'

/**
 * Noticing that a plugin on disk has changed.
 *
 * Deliberately simple: it says "something under here changed", and the caller
 * decides what that is worth. Working out *which* plugin changed from a
 * filesystem event is a rabbit hole — editors write temp files, rename over
 * the target, and touch directories — and reloading all of them costs
 * milliseconds.
 *
 * Settled before it fires, because saving one file in an editor produces
 * three or four events and reloading four times would mean three reloads of a
 * file half-written.
 */
export type Watch = { close(): void }

export const SETTLE_MS = 250

export function watchDirectories(
  directories: string[],
  onChange: () => void,
  settleMs = SETTLE_MS,
): Watch {
  const watchers: FSWatcher[] = []
  let pending: ReturnType<typeof setTimeout> | undefined

  const settle = (): void => {
    if (pending) clearTimeout(pending)
    pending = setTimeout(() => {
      pending = undefined
      onChange()
    }, settleMs)
    // Never a reason to hold the process open: a watcher is a convenience,
    // and a session that will not exit because of one is a bug people blame
    // on the whole program.
    pending.unref?.()
  }

  for (const directory of new Set(directories)) {
    try {
      watchers.push(watch(directory, { recursive: true }, settle))
    } catch {
      // A directory nobody has created yet is simply one with no changes.
      // Watching it into existence would mean watching its parent, which is
      // somebody's home directory.
    }
  }

  return {
    close(): void {
      if (pending) clearTimeout(pending)
      for (const watcher of watchers) watcher.close()
    },
  }
}
