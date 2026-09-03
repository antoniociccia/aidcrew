import type { MeterWindow } from '@aidcrew/core'

/**
 * What is left of a plan, for the services that sell one.
 *
 * A price per token is the wrong question for a flat plan: the answer is
 * always zero and it tells you nothing you needed. What you actually want to
 * know is how much of the plan is gone and when it comes back, which is what
 * OpenCode publishes and what a subscription is really metered in.
 *
 * Nothing here is a price. A service that sells tokens gets costed; a service
 * that sells a plan gets this; and a service that publishes neither gets
 * neither, which is honest and legible in a way an invented number is not.
 */

export type Window = {
  /** Which allowance this is: the rolling few hours, the week, the month. */
  name: string
  /** How much of it has been used, from 0 to 100. */
  percent: number
  /** When it starts again. */
  resetsAt: Date
  /** Whatever the service calls the state, passed through rather than judged. */
  status: string
}

export type Allowance = {
  providerId: string
  windows: Window[]
}

/**
 * Reads the shape OpenCode publishes at `/usage`.
 *
 * Unknown windows are kept rather than filtered to a list we know: a service
 * that adds a daily allowance next month should show it without a release
 * here, and a window we cannot name is still a window somebody can read.
 */
export function fromUsage(body: unknown, providerId: string): Allowance | undefined {
  const usage = (body as { usage?: Record<string, unknown> })?.usage
  if (typeof usage !== 'object' || usage === null) return undefined

  const windows: Window[] = []
  for (const [name, value] of Object.entries(usage)) {
    const window = value as { percent?: unknown; resetsAt?: unknown; status?: unknown }
    if (typeof window?.percent !== 'number') continue

    const resetsAt = typeof window.resetsAt === 'string' ? new Date(window.resetsAt) : undefined
    windows.push({
      name,
      percent: window.percent,
      resetsAt: resetsAt && !Number.isNaN(resetsAt.getTime()) ? resetsAt : new Date(0),
      status: typeof window.status === 'string' ? window.status : 'unknown',
    })
  }

  return windows.length === 0 ? undefined : { providerId, windows }
}

/**
 * The same thing, from a provider that says it mid-stream rather than at an
 * endpoint somebody has to go and ask.
 *
 * The wire carries a fraction and a window here carries a percentage, and this
 * is the one place the two meet. Converting once, at the boundary, is what
 * stops a `0.02` being drawn as "2% used" in one row and "0.02% used" in the
 * next — and everything downstream keeps reading one shape from two suppliers.
 */
export function fromMeter(windows: MeterWindow[], providerId: string): Allowance | undefined {
  if (windows.length === 0) return undefined

  return {
    providerId,
    windows: windows.map((window) => ({
      name: window.name,
      percent: window.usedFraction * 100,
      resetsAt: window.resetsAt,
      // Nothing said it was anything else. A provider that reports its windows
      // while answering is, by saying so, still answering.
      status: 'ok',
    })),
  }
}

/**
 * The window worth showing, which is the one closest to running out.
 *
 * A plan with three allowances is limited by whichever is nearest its end, and
 * that is the one a person needs to see — not the average, and not the first
 * in the list.
 */
export function tightest(allowance: Allowance): Window | undefined {
  return [...allowance.windows].sort((a, b) => b.percent - a.percent)[0]
}

/** How much is left, said the way somebody would ask it. */
export function left(window: Window, now = new Date()): string {
  const remaining = Math.max(0, 100 - window.percent)
  const until = window.resetsAt.getTime() - now.getTime()

  // No point saying when it resets if that has already happened: the service
  // will have moved the window on and simply not told us yet.
  if (until <= 0) return `${remaining}% ${window.name}`

  const hours = Math.round(until / 3_600_000)
  const when = hours < 1 ? 'under an hour' : hours < 48 ? `${hours}h` : `${Math.round(hours / 24)}d`

  return `${remaining}% ${window.name}, back in ${when}`
}

/** When the question is being asked, and in whose clock the answer is read. */
export type When = { now: Date; timeZone?: string }

/**
 * Every window on one row, shortest first, with when the tightest comes back.
 *
 * A plan is metered several ways at once — a rolling few hours, a week, a
 * month — and showing only the tightest answers "can I work right now" while
 * hiding "will this last to the end of the month". Both are worth knowing,
 * and with the service's name in front the row still fits a tray.
 *
 * Used rather than left, because that is the number the service publishes and
 * the number its own site shows: two screens disagreeing by a subtraction is
 * a thing people stop to check.
 */
export function allLeft(allowance: Allowance, when: When = { now: new Date() }): string {
  const windows = inOrder(allowance)
  const said = windows
    .map((window) => `${nameOf(window)} ${exhausted(window) ? 'exhausted' : `${window.percent}%`}`)
    .join(' \u00b7 ')

  const matters = whatMatters(allowance, when)
  const resets = matters === undefined ? '' : `, resets ${at(matters.resetsAt, when)}`
  return `${serviceOf(allowance)}: ${said}${resets}`
}

/**
 * What changed about a plan that is worth a line in the transcript.
 *
 * The tray shows the figure for as long as it is true, which is right for a
 * figure and wrong for news: an afternoon can end on a plan nobody saw
 * running down. So a window passing four fifths, then passing nineteen
 * twentieths, then closing, is said once each — and said again the other way
 * when it comes back, because that is when work can start again.
 *
 * `before` absent is the first answer of a session: a plan already high has
 * to be reported, since nobody was there to watch it climb.
 */
export function crossings(
  before: Allowance | undefined,
  after: Allowance,
  when: When = { now: new Date() },
): string[] {
  const was = new Map((before?.windows ?? []).map((window) => [window.name, level(window)]))
  const said: string[] = []

  for (const window of inOrder(after)) {
    const from = was.get(window.name) ?? 0
    const to = level(window)
    if (to === from) continue

    // Down only from closed. A window bobbing either side of four fifths
    // would otherwise chatter, and none of it would be news.
    if (to < from) {
      if (from === CLOSED) {
        said.push(
          `${serviceOf(after)}: the ${nameOf(window)} plan is back, ${window.percent}% used`,
        )
      }
      continue
    }

    said.push(announce(serviceOf(after), window, to, when))
  }

  return said
}

/**
 * When the plan comes back, said the way an error can carry it.
 *
 * A 429 that says "quota exceeded" is a sentence with no time in it, and the
 * time is the only part of it anybody can act on.
 */
export function planReset(
  allowance: Allowance,
  when: When = { now: new Date() },
): string | undefined {
  const window = whatMatters(allowance, when)
  if (window === undefined) return undefined
  return `the ${nameOf(window)} plan resets ${at(window.resetsAt, when)}`
}

/**
 * Whether a provider's refusal is about the plan rather than the request.
 *
 * By what it says, not by its status code: the code is gone by the time the
 * sentence reaches a pane, because the provider folds it into the message.
 */
export function aboutThePlan(message: string): boolean {
  return /\b(quota|rate.?limit|too many requests|payment required|402|429|out of credit|insufficient (balance|credit)|plan (limit|quota|exhausted))\b/i.test(
    message,
  )
}

/** Below four fifths, past it, nearly gone, and closed. */
const HIGH = 1
const NEARLY_GONE = 2
const CLOSED = 3

function level(window: Window): number {
  if (exhausted(window)) return CLOSED
  if (window.percent >= 95) return NEARLY_GONE
  if (window.percent >= 80) return HIGH
  return 0
}

/**
 * Closed, whatever the number says.
 *
 * The status is the service's own word for it and is trusted over the
 * percentage: a service that stops serving at 60% has stopped serving.
 */
function exhausted(window: Window): boolean {
  return window.percent >= 100 || (window.status !== 'ok' && window.status !== 'unknown')
}

function announce(service: string, window: Window, to: number, when: When): string {
  const back = at(window.resetsAt, when)
  const name = nameOf(window)
  if (to === CLOSED) {
    return `${service}: the ${name} plan is exhausted${back === undefined ? '' : ` until ${back}`}`
  }
  const nearly = to === NEARLY_GONE ? 'nearly gone, ' : ''
  const resets = back === undefined ? '' : `, resets ${back}`
  return `${service}: the ${name} plan is ${nearly}${window.percent}% used${resets}`
}

/**
 * The window whose reset is worth showing.
 *
 * The soonest one, because that is what moves next — until something is
 * nearly gone, and then it is the one that will stop you, however far off its
 * reset is. A window whose reset has already passed says nothing: the service
 * has moved it on and not told us, and a time in the past beside a clock
 * reads as a number that is stuck.
 */
function whatMatters(allowance: Allowance, when: When): Window | undefined {
  const upcoming = allowance.windows.filter(
    (window) => window.resetsAt.getTime() > when.now.getTime(),
  )
  if (upcoming.length === 0) return undefined

  const highest = [...upcoming].sort((a, b) => b.percent - a.percent)[0] as Window
  if (highest.percent >= 80) return highest

  return [...upcoming].sort((a, b) => a.resetsAt.getTime() - b.resetsAt.getTime())[0]
}

/** The windows in the order they run out in, which is the order to read them. */
function inOrder(allowance: Allowance): Window[] {
  const order = ['rolling', 'daily', 'hourly', 'weekly', 'monthly']
  const rank = (window: Window): number => {
    const at = order.indexOf(window.name.toLowerCase())
    return at === -1 ? order.length : at
  }
  return [...allowance.windows].sort(
    (a, b) => rank(a) - rank(b) || a.resetsAt.getTime() - b.resetsAt.getTime(),
  )
}

/**
 * What a service is called in a tray, which is the last word of its id.
 *
 * `opencode-go` is "go" on a row that already has three windows and a cost on
 * it, and nobody running two services confuses the two by their last word.
 */
function serviceOf(allowance: Allowance): string {
  return allowance.providerId.split('-').pop() ?? allowance.providerId
}

/** A window's name in the words people use for these: a span, not a schedule. */
function nameOf(window: Window): string {
  const known: Record<string, string> = {
    rolling: '5h',
    hourly: 'hour',
    daily: 'day',
    weekly: 'week',
    monthly: 'month',
  }
  return known[window.name.toLowerCase()] ?? window.name
}

/**
 * When something comes back, at the precision that far ahead deserves.
 *
 * Today it is a clock time, this week a day and a time, and further out a
 * date: "resets 24 Sep" is what somebody wants of a month, and "resets
 * 12:21" is what they want of the next few hours.
 */
function at(resetsAt: Date, when: When): string | undefined {
  const until = resetsAt.getTime() - when.now.getTime()
  if (until <= 0) return undefined

  const zone = when.timeZone
  const options: Intl.DateTimeFormatOptions =
    until < 24 * 3_600_000
      ? { hour: '2-digit', minute: '2-digit', hour12: false }
      : until < 7 * 24 * 3_600_000
        ? { weekday: 'short', hour: '2-digit', minute: '2-digit', hour12: false }
        : { day: 'numeric', month: 'short' }

  return new Intl.DateTimeFormat('en-GB', {
    ...options,
    ...(zone ? { timeZone: zone } : {}),
  })
    .format(resetsAt)
    .replace(',', '')
}
