/**
 * Making the host's own modules importable from a plugin.
 *
 * A plugin lives where nobody has run `bun install`: `~/.aidcrew/plugins`, or
 * a directory in somebody else's project. Every example ever written for this
 * project begins with
 *
 *     import { definePlugin } from '@aidcrew/plugin-sdk'
 *
 * and outside this repository that import failed with "Cannot find module".
 * The documented way to write a plugin did not work, and it was the first
 * thing anybody would try.
 *
 * So the host hands its own copies over instead. The modules are already
 * inside the binary — the SDK is what the bundled plugins are written with —
 * and this makes them resolvable by name from anywhere. Nothing is downloaded
 * and nothing is installed: a plugin can reach exactly what is offered here
 * and nothing else, so an import of some package nobody has still fails, and
 * still says which one.
 */

/** Every name served so far, so the same one twice is the newer one. */
const served = new Map<string, unknown>()

export function serveToPlugins(modules: Record<string, unknown>): void {
  const fresh = Object.entries(modules).filter(([name]) => !served.has(name))
  for (const [name, exports] of Object.entries(modules)) served.set(name, exports)
  if (fresh.length === 0) return

  // One registration per batch of new names. `setup` runs when the plugin is
  // registered and not again, so names added later need their own — reusing
  // the first registration would leave them unresolvable, which is the bug
  // this whole file exists to prevent, one level down.
  Bun.plugin({
    name: `aidcrew-host-modules-${served.size}`,
    setup(build) {
      for (const [name] of fresh) {
        build.module(name, () => ({
          exports: served.get(name) as Record<string, unknown>,
          loader: 'object',
        }))
      }
    },
  })
}

/** What is currently offered, for a diagnostic that has to explain a failure. */
export function servedToPlugins(): string[] {
  return [...served.keys()].sort()
}
