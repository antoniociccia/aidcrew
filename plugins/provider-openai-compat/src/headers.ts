import type { MeterWindow } from '@aidcrew/core'
import { meterWindow } from '@aidcrew/plugin-sdk'

/**
 * What the response headers say is left of the allowance.
 *
 * OpenAI, and the gateways that copy its headers, report two families —
 * requests and tokens — each as a limit, what remains of it, and how long
 * until it refills. The canonical model already has a place for exactly this
 * (the meter delta the subprocess provider fills from its own program's
 * report), so a plain HTTP service can be shown the same way.
 *
 * A family with any of the three missing is left out rather than guessed at:
 * Ollama sends none of these, and a window made from nothing would put a
 * number nobody can check on the screen.
 */
export function meterFromHeaders(headers: Headers, now = Date.now()): MeterWindow[] {
  const windows: MeterWindow[] = []
  for (const family of ['requests', 'tokens']) {
    const reset = headers.get(`x-ratelimit-reset-${family}`)
    const window = meterWindow(family, {
      limit: numberIn(headers.get(`x-ratelimit-limit-${family}`)),
      remaining: numberIn(headers.get(`x-ratelimit-remaining-${family}`)),
      resetsAt: reset === null ? undefined : resetsAt(reset, now),
    })
    if (window) windows.push(window)
  }
  return windows
}

function numberIn(value: string | null): number | undefined {
  if (value === null) return undefined
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : undefined
}

/**
 * When a window refills, from how long the service says is left on it.
 *
 * Written the way Go prints a duration — `6m0s`, `1s`, `20ms`, `1h2m3.5s` —
 * because that is what the service is written in. Not seconds and not a
 * date, so neither of the usual readers gets it right. A bare number is
 * taken as seconds, which is how a gateway that rounds it off sends it.
 */
function resetsAt(duration: string, now: number): Date | undefined {
  const trimmed = duration.trim()
  if (/^\d+(\.\d+)?$/.test(trimmed)) return new Date(now + Number(trimmed) * 1000)

  let ms = 0
  let rest = trimmed
  const part = /^(\d+(?:\.\d+)?)(ms|h|m|s)/
  while (rest !== '') {
    const match = part.exec(rest)
    if (!match) return undefined
    const amount = Number(match[1])
    ms +=
      amount *
      (match[2] === 'h' ? 3_600_000 : match[2] === 'm' ? 60_000 : match[2] === 's' ? 1000 : 1)
    rest = rest.slice(match[0].length)
  }
  return new Date(now + ms)
}
