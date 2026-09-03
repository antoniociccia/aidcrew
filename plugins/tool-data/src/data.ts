import { readFile, stat } from 'node:fs/promises'
import { defineTool } from '@aidcrew/plugin-sdk'
import { explainMissing, resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'

/**
 * One value out of a JSON or TOML file.
 *
 * The question is almost always small — which version of zod, what model
 * the provider is set to — and the only way to answer it has been to read
 * the whole file, which for a lockfile is the whole context window. These
 * parse the file and return the one thing asked for; and when the path is
 * wrong they say where it went wrong and what was there instead, which is
 * what lets the next call be right.
 */

/** Past this a file is data, not config, and parsing it whole costs seconds. */
const MAX_FILE_BYTES = 20_000_000
/** Enough JSON to see a value, not enough to fill a context window. */
const MAX_OUTPUT = 50_000
const MAX_KEYS_LISTED = 200
const MAX_KEYS_IN_ERROR = 30
const MAX_INLINE_VALUE = 60

type Format = 'JSON' | 'TOML'
type Segment = string | number
type Parsed = { value: unknown } | { failure: string }
type Input = { path: string; key?: string | undefined }
type Output = { content: string; isError?: boolean }

const schemaFor = (format: Format) =>
  z.object({
    path: z.string().describe(`${format} file, relative to the workspace.`),
    key: z
      .string()
      .optional()
      .describe(
        'Path to the value: dependencies.zod, agents[0].name, paths["a.b"]. Omit for the top-level keys; "." for the whole file.',
      ),
  })

export const jsonTool = defineTool({
  name: 'json',
  reads: true,
  description:
    'Read one value out of a JSON file by path — dependencies.zod, agents[0].name — without ' +
    'reading the file. Objects come back as JSON, strings as plain text; with no key it lists ' +
    'the top-level keys. Use it instead of read for package.json, tsconfig.json and lockfiles.',
  schema: schemaFor('JSON'),
  run: (input, { cwd }) => lookup('JSON', parseJson, input, cwd),
})

export const tomlTool = defineTool({
  name: 'toml',
  reads: true,
  description:
    'Read one value out of a TOML file by path — provider.model, agents[0].name — without ' +
    'reading the file. Tables come back as JSON, strings as plain text; with no key it lists ' +
    'the top-level keys. Use it instead of read for .aidcrew/config.toml and bunfig.toml.',
  schema: schemaFor('TOML'),
  run: (input, { cwd }) => lookup('TOML', parseToml, input, cwd),
})

async function lookup(
  format: Format,
  parse: (text: string) => Parsed,
  { path, key = '' }: Input,
  cwd: string,
): Promise<Output> {
  const segments = parseKey(key)
  if (segments === undefined) {
    return {
      content:
        `"${key}" is not a path this tool understands. Write dependencies.zod, agents[0].name ` +
        'or paths["a.b"], and leave the key out to see the top-level keys.',
      isError: true,
    }
  }

  const resolved = resolveInWorkspace(cwd, path)
  const source = await readSource(cwd, path, resolved)
  if ('refusal' in source) return { content: source.refusal, isError: true }

  const parsed = parse(source.text)
  if ('failure' in parsed) {
    return { content: `${path} is not valid ${format}: ${parsed.failure}`, isError: true }
  }

  const found = follow(parsed.value, segments)
  if ('missing' in found) return { content: found.missing, isError: true }

  // No key is a question about shape; "." asks for the whole document.
  const whole = key.trim() === '.'
  return {
    content: segments.length === 0 && !whole ? overview(found.value) : render(found.value),
  }
}

async function readSource(
  cwd: string,
  path: string,
  resolved: string,
): Promise<{ text: string } | { refusal: string }> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(resolved)
  } catch {
    return { refusal: explainMissing(cwd, path) ?? `${path} does not exist` }
  }
  if (info.isDirectory()) return { refusal: `${path} is a directory; use tree to list it` }
  if (info.size > MAX_FILE_BYTES) {
    return { refusal: `${path} is ${info.size} bytes, too large to parse as one value` }
  }

  const text = await readFile(resolved, 'utf8')
  // A byte order mark is not JSON, but Windows editors write one anyway.
  return { text: text.startsWith('﻿') ? text.slice(1) : text }
}

function parseJson(text: string): Parsed {
  try {
    return { value: JSON.parse(text) }
  } catch (strict) {
    // Comments and trailing commas are not JSON, but tsconfig.json and every
    // editor's settings have them, so a file rejected as strict JSON is tried
    // again as JSONC before anybody is told it is broken.
    try {
      return { value: Bun.JSONC.parse(text) }
    } catch (loose) {
      const at = position(loose) ?? whereTokenIs(text, message(loose))
      return {
        failure: at ? `${message(strict)} (parsing stopped at ${said(at)})` : message(strict),
      }
    }
  }
}

function parseToml(text: string): Parsed {
  try {
    return { value: Bun.TOML.parse(text) }
  } catch (cause) {
    const at = position(cause) ?? whereParsingStops(text, (of) => Bun.TOML.parse(of))
    return { failure: at ? `${message(cause)} at ${said(at)}` : message(cause) }
  }
}

/**
 * The segments of a key: `a.b[2].c` is `a`, `b`, `2`, `c`. A name goes on
 * until a dot or a bracket; a bracket holds an index, or a quoted name for a
 * key that itself contains a dot. Anything else is refused rather than
 * guessed at, because a guess that lands on the wrong key looks like an
 * answer.
 */
export function parseKey(key: string): Segment[] | undefined {
  const text = key.trim()
  if (text === '' || text === '.') return []

  const segments: Segment[] = []
  let at = 0
  while (at < text.length) {
    const piece = text[at] === '.' ? afterDot(text, at) : readSegment(text, at)
    if (piece === undefined) return undefined
    if (piece.segment !== undefined) segments.push(piece.segment)
    at = piece.end
  }
  return segments
}

type Piece = { segment: Segment; end: number } | { segment?: undefined; end: number }

/** A dot separates two names; one at either end, or beside another dot or a bracket, is a slip. */
function afterDot(text: string, at: number): Piece | undefined {
  const next = text[at + 1]
  if (at === 0 || next === undefined || next === '.' || next === '[') return undefined
  return { end: at + 1 }
}

/** A bracketed index or name, or a bare name running up to the next dot or bracket. */
function readSegment(text: string, at: number): Piece | undefined {
  if (text[at] === '[') return readBracket(text, at)

  let end = at
  while (end < text.length && text[end] !== '.' && text[end] !== '[') end += 1
  const name = text.slice(at, end)
  return name.includes(']') ? undefined : { segment: name, end }
}

/** What a `[...]` at this position holds, and where it ends. */
function readBracket(text: string, at: number): { segment: Segment; end: number } | undefined {
  const quote = text[at + 1]
  if (quote === '"' || quote === "'") {
    const close = text.indexOf(quote, at + 2)
    if (close === -1 || text[close + 1] !== ']') return undefined
    return { segment: text.slice(at + 2, close), end: close + 2 }
  }

  const close = text.indexOf(']', at + 1)
  if (close === -1) return undefined
  const inside = text.slice(at + 1, close)
  if (!/^\d+$/.test(inside)) return undefined
  return { segment: Number(inside), end: close + 1 }
}

type Step = { value: unknown } | { missing: string }

/**
 * Walks the parsed value along the segments. The message for a wrong turn
 * says how far the path got, what was found there and what the choices
 * were, so a model reads it and corrects the key instead of trying variants.
 */
function follow(root: unknown, segments: Segment[]): Step {
  let current = root
  let walked = ''

  for (const segment of segments) {
    const next = spell(walked, segment)
    const stepped = step(current, segment, walked, next)
    if ('missing' in stepped) return stepped
    current = stepped.value
    walked = next
  }
  return { value: current }
}

function step(current: unknown, segment: Segment, walked: string, next: string): Step {
  const here = walked === '' ? 'the top level' : walked

  if (Array.isArray(current)) {
    if (typeof segment !== 'number') {
      return {
        missing: `${next} does not exist: ${here} is an array (${count(current.length, 'item', 'items')}), so it takes an index like ${spell(walked, 0)}, not a key`,
      }
    }
    if (segment >= current.length) {
      return {
        missing: `${next} does not exist: ${here} has ${count(current.length, 'item', 'items')}`,
      }
    }
    return { value: current[segment] }
  }

  if (isRecord(current)) {
    const name = String(segment)
    if (Object.hasOwn(current, name)) return { value: current[name] }
    const exists = walked === '' ? 'the top level' : `${walked} exists but`
    return {
      missing: `${next} does not exist: ${exists} has no key ${JSON.stringify(name)}. Keys there: ${keysOf(current)}`,
    }
  }

  return {
    missing: `${next} cannot be reached: ${here} is ${describe(current)}, which has nothing inside`,
  }
}

/** The key as it would be written: `a.b`, `a[0]`, `a["with.dot"]`. */
function spell(walked: string, segment: Segment): string {
  if (typeof segment === 'number') return `${walked}[${segment}]`
  if (/[.[\]]/.test(segment)) return `${walked}[${JSON.stringify(segment)}]`
  return walked === '' ? segment : `${walked}.${segment}`
}

/** The top of a file, which is what somebody exploring wants: every key and what it holds. */
function overview(value: unknown): string {
  if (Array.isArray(value)) {
    return `${kind(value)}; ask for [0] to see the first item`
  }
  if (!isRecord(value)) return render(value)

  const keys = Object.keys(value)
  const lines = keys.slice(0, MAX_KEYS_LISTED).map((key) => `${key}: ${kind(value[key])}`)
  if (keys.length > MAX_KEYS_LISTED) {
    lines.push(`... and ${keys.length - MAX_KEYS_LISTED} more keys`)
  }
  return `${count(keys.length, 'key', 'keys')}:\n${lines.join('\n')}`
}

/** What a value is, in a word, with the value itself when it is short. */
function kind(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (Array.isArray(value)) return `array (${count(value.length, 'item', 'items')})`
  if (isRecord(value)) return `object (${count(Object.keys(value).length, 'key', 'keys')})`
  const shown = typeof value === 'string' ? JSON.stringify(value) : String(value)
  return `${typeof value} ${shown.length > MAX_INLINE_VALUE ? `${shown.slice(0, MAX_INLINE_VALUE)}…` : shown}`
}

function render(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') return value
  if (typeof value !== 'object') return String(value)

  const json = JSON.stringify(value, null, 2)
  if (json.length <= MAX_OUTPUT) return json
  return `${json.slice(0, MAX_OUTPUT)}\n... cut at ${MAX_OUTPUT} characters; the whole value is ${json.length} as JSON. Ask for a key inside it.`
}

function describe(value: unknown): string {
  if (value === null || value === undefined) return 'null'
  if (typeof value === 'string') {
    const shown = JSON.stringify(value)
    return `a string (${shown.length > MAX_INLINE_VALUE ? `${shown.slice(0, MAX_INLINE_VALUE)}…` : shown})`
  }
  return `a ${typeof value} (${String(value)})`
}

function keysOf(record: Record<string, unknown>): string {
  const keys = Object.keys(record)
  if (keys.length === 0) return 'none, it is empty'
  const shown = keys.slice(0, MAX_KEYS_IN_ERROR).join(', ')
  return keys.length > MAX_KEYS_IN_ERROR
    ? `${shown}, and ${keys.length - MAX_KEYS_IN_ERROR} more`
    : shown
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Where parsing stopped, in the words the failure is reported in.
 *
 * The column is optional because one of the two ways of finding the spot knows
 * only the line, and half an answer is still an answer.
 */
type Spot = { line: number; column?: number }

function said(at: Spot): string {
  return at.column === undefined ? `line ${at.line}` : `line ${at.line}, column ${at.column}`
}

/**
 * The spot the runtime gave, when it gives one.
 *
 * Bun used to hang a `{line, column}` off a parse error. 1.4 stopped: what is
 * on the error there is where the parse *call* is — the same two numbers for
 * every file this program reads — so it cannot be used, and the two functions
 * below work the spot out instead. This still runs first because when the
 * runtime does say, it is the parser talking and nothing here can do better.
 */
function position(cause: unknown): Spot | undefined {
  const at = (cause as { position?: { line?: unknown; column?: unknown } } | null)?.position
  if (typeof at?.line === 'number' && typeof at.column === 'number') {
    return { line: at.line, column: at.column }
  }
  return undefined
}

/**
 * The token the parser named, found in the text.
 *
 * `Unexpected tru` is the shape the mistake people actually make comes back
 * in, and the token is enough to find the line. It is the first occurrence
 * that is reported, which is a guess when the same text appears earlier — so
 * a token of one character, where that is likely, is not used at all. A line
 * that is wrong sends somebody to the wrong place, which is worse than a
 * message that admits it does not know.
 */
function whereTokenIs(text: string, complaint: string): Spot | undefined {
  const named = /Unexpected ([^\s,]{2,})/.exec(complaint)?.[1]
  if (named === undefined) return undefined

  const at = text.indexOf(named)
  if (at < 0) return undefined

  const before = text.slice(0, at)
  return { line: before.split('\n').length, column: at - before.lastIndexOf('\n') }
}

/**
 * How much walking the line search is worth. Each step is a parse of
 * everything above it, so a long file costs the square of its length; a
 * position is a convenience and not worth a pause anybody would notice.
 */
const MOST_LINES_WALKED = 500

/**
 * The first line that stops the file parsing, for a format read a line at a
 * time.
 *
 * The longest run of lines that still parses, and then the one after it. Not
 * "the first line that fails on its own": a multi-line array is three lines of
 * which only the last parses alone, and blaming its opening bracket would be
 * both wrong and confidently wrong.
 */
function whereParsingStops(text: string, parse: (of: string) => unknown): Spot | undefined {
  const lines = text.split('\n')
  if (lines.length > MOST_LINES_WALKED) return undefined

  let good = 0
  for (let n = 1; n < lines.length; n += 1) {
    try {
      parse(lines.slice(0, n).join('\n'))
      good = n
    } catch {
      // Not this far — but a later line may close whatever this one opened,
      // so the walk carries on rather than stopping at the first complaint.
    }
  }

  return { line: good + 1 }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause)
}

function count(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`
}
