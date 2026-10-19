// A model's reply is text. The decision is the first balanced JSON object in
// it that parses; fences, preambles and trailing chatter are ignored.

export interface ParsedDecision {
  action: unknown
  rationale?: string
}

export function parseDecision(text: string): ParsedDecision {
  for (const candidate of objects(text)) {
    let value: unknown
    try {
      value = JSON.parse(candidate)
    } catch {
      continue
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) continue
    const obj = value as Record<string, unknown>
    if ('action' in obj) {
      return typeof obj.rationale === 'string'
        ? { action: obj.action, rationale: obj.rationale }
        : { action: obj.action }
    }
    if (typeof obj.type === 'string') return { action: obj }
    return { action: undefined }
  }
  return { action: undefined }
}

/** Every balanced {...} span, outermost first, aware of strings and escapes. */
function* objects(text: string): Generator<string> {
  for (let start = text.indexOf('{'); start >= 0; start = text.indexOf('{', start + 1)) {
    const end = closing(text, start)
    if (end > 0) yield text.slice(start, end + 1)
  }
}

function closing(text: string, start: number): number {
  let depth = 0
  for (let i = start; i < text.length; i++) {
    const c = text[i]
    if (c === '"') {
      i = stringEnd(text, i)
      if (i < 0) return -1
    } else if (c === '{') depth++
    else if (c === '}' && --depth === 0) return i
  }
  return -1
}

function stringEnd(text: string, open: number): number {
  for (let i = open + 1; i < text.length; i++) {
    if (text[i] === '\\') i++
    else if (text[i] === '"') return i
  }
  return -1
}
