/**
 * Turning "that model does not exist" into a name the person can use.
 *
 * Endpoints are bad at saying this. One answers `Endpoint is unavailable`
 * for a model it has never heard of — a sentence about the network for a
 * mistake in a config file — so a typo reads as an outage and gets waited out
 * rather than fixed. Another answers `model: claude-opus-5` and nothing else.
 * The catalogue says which names exist; this says which of them was meant.
 *
 * In the SDK rather than in one provider because every dialect has the same
 * problem and the same fix, and a plugin written by a stranger should be able
 * to offer the same shortlist.
 */

const HOW_MANY = 3

/**
 * How close two names have to look before saying them out loud.
 *
 * Tuned against the live case: `deepseek-v4-flsh` must reach
 * `deepseek-v4-flash`, and `banana` must reach nothing. Set lower and every
 * error grows a shortlist of unrelated models, which is how people learn to
 * stop reading the last line of an error.
 */
const CLOSE_ENOUGH = 0.3

/** The models most like the one that was asked for, best first, possibly none. */
export function nearest(wanted: string, available: string[]): string[] {
  const target = trigrams(wanted)
  if (target.size === 0) return []

  return available
    .map((candidate) => ({ candidate, score: overlap(target, trigrams(candidate)) }))
    .filter((one) => one.score >= CLOSE_ENOUGH)
    .sort((a, b) => b.score - a.score || a.candidate.localeCompare(b.candidate))
    .slice(0, HOW_MANY)
    .map((one) => one.candidate)
}

/**
 * Trigrams rather than edit distance, because model names differ by chunks
 * rather than by characters: `qwen3.8-flash` and `qwen3.6-plus` are six edits
 * apart, which puts them past any threshold that still excludes nonsense, but
 * they share the piece that identifies the family.
 */
function trigrams(name: string): Set<string> {
  const padded = `  ${name.toLowerCase()} `
  const found = new Set<string>()
  for (let i = 0; i + 3 <= padded.length; i++) found.add(padded.slice(i, i + 3))
  return found
}

/** Shared trigrams over the smaller set, so a long name is not penalised. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (b.size === 0) return 0
  let shared = 0
  for (const gram of a) if (b.has(gram)) shared++
  return shared / Math.min(a.size, b.size)
}
