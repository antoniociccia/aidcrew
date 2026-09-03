import type {
  Hooks,
  Loader,
  ModelPrice,
  PriceSource,
  UiContext,
  UiExtension,
  UiSegment,
  UiSlot,
} from '@aidcrew/core'

/**
 * Helpers for the four capabilities that had none.
 *
 * `tools` and `providers` were declared through defineTool and defineProvider,
 * which check their shape and explain themselves when it is wrong. Hooks,
 * loaders, prices and UI were plain object literals — and a typo in one of
 * those produces *silence*: a hook that never runs, a slot that never draws,
 * nothing thrown anywhere. Silence is the most expensive thing a contract can
 * do to somebody learning it, and it is the reason these exist.
 */

const HOOK_NAMES = ['preTurn', 'preToolCall', 'postToolCall'] as const

/**
 * Declares hooks, refusing a name that is not one.
 *
 * `preToolcall` is not `preToolCall`. Written as a literal it type-checks in a
 * plugin that has no TypeScript set up, loads, registers, and then does
 * nothing at all for the rest of its life.
 */
export function defineHooks<H extends Hooks>(hooks: H): H {
  for (const [name, value] of Object.entries(hooks)) {
    if (!HOOK_NAMES.includes(name as (typeof HOOK_NAMES)[number])) {
      const near = nearest(name, HOOK_NAMES)
      throw new Error(
        `defineHooks: "${name}" is not a hook${near ? `. Did you mean "${near}"?` : ''} ` +
          `The hooks are: ${HOOK_NAMES.join(', ')}`,
      )
    }
    if (typeof value !== 'function') {
      throw new Error(`defineHooks: "${name}" must be a function, not a ${typeof value}`)
    }
  }
  return hooks
}

export type UiSpec = {
  /** Which slots this draws in. Absent means all of them. */
  slots?: UiSlot[]
  render(context: UiContext): UiSegment[] | undefined
}

const UI_SLOTS: UiSlot[] = ['tray', 'agent']

/**
 * Declares an addition to the interface.
 *
 * Does three things a hand-written literal did not: refuses a slot that does
 * not exist, only calls `render` for the slots this asked for, and catches
 * what `render` throws so a plugin's bug costs its own line rather than the
 * frame. The interface catches too — but by then the plugin author has no way
 * of knowing it was theirs.
 */
export function defineUi(spec: UiSpec): UiExtension {
  if (typeof spec?.render !== 'function') {
    throw new Error('defineUi: "render" must be a function (context) => UiSegment[] | undefined')
  }
  for (const slot of spec.slots ?? []) {
    if (!UI_SLOTS.includes(slot)) {
      throw new Error(`defineUi: "${slot}" is not a slot. The slots are: ${UI_SLOTS.join(', ')}`)
    }
  }

  const wanted = spec.slots
  return {
    render(context: UiContext): UiSegment[] | undefined {
      if (wanted && !wanted.includes(context.slot)) return undefined
      try {
        return spec.render(context)
      } catch {
        // One slot, not the screen. Drawing happens on every frame, so an
        // error reported here would be reported sixty times a second.
        return undefined
      }
    },
  }
}

/** Declares a reader for a file format, refusing one that reads nothing. */
export function defineLoader<L extends Loader>(loader: L): L {
  if (typeof loader?.name !== 'string' || loader.name === '') {
    throw new Error('defineLoader: a loader needs a "name"')
  }
  const reads = ['loadInstructions', 'loadSkills', 'loadAgents'] as const
  if (!reads.some((name) => typeof (loader as Loader)[name] === 'function')) {
    throw new Error(
      `defineLoader("${loader.name}"): a loader needs at least one of ${reads.join(', ')} — ` +
        'without one it will never be asked for anything',
    )
  }
  return loader
}

export type PriceSpec = {
  id: string
  covers(providerId: string): boolean
  load(providerId: string, config: unknown): Promise<Record<string, ModelPrice>>
}

/** Declares where the price of a model comes from. */
export function definePrices(spec: PriceSpec): PriceSource {
  if (typeof spec?.id !== 'string' || spec.id === '') {
    throw new Error('definePrices: a price source needs an "id"')
  }
  if (typeof spec.covers !== 'function') {
    throw new Error(
      `definePrices("${spec.id}"): "covers" must say which services this knows about, ` +
        'or it will be asked about every one of them',
    )
  }
  if (typeof spec.load !== 'function') {
    throw new Error(`definePrices("${spec.id}"): "load" must be a function`)
  }
  return spec
}

/** The closest of a small set of known names, for a "did you mean". */
function nearest(typed: string, known: readonly string[]): string | undefined {
  const lower = typed.toLowerCase()
  return known.find((name) => name.toLowerCase() === lower)
}
