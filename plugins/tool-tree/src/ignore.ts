/**
 * A reading of `.gitignore`, enough for a listing to skip what git skips.
 *
 * Not the whole of gitignore(5), but the parts every real file uses: a bare
 * name matches at any depth, a slash anchors, a trailing slash means only a
 * directory, `*` stops at a slash, `**` does not, `!` re-includes, and the
 * last rule to match decides. Everything is compiled once and matched with
 * regular expressions, so a listing of a few hundred entries costs nothing.
 */

type Rule = { expression: RegExp; negated: boolean; directoryOnly: boolean }

/**
 * Whether git would ignore a path, relative to the directory the `.gitignore`
 * sits in. `undefined` when no rule mentions it — the difference matters when
 * a deeper `.gitignore` has to override a shallower one, which it does only
 * when it actually says something about the path.
 */
export type Verdict = (path: string, isDirectory: boolean) => boolean | undefined

export function compileIgnore(body: string): Verdict {
  const rules = body.split('\n').flatMap((line) => {
    const rule = compileRule(line)
    return rule === undefined ? [] : [rule]
  })

  return (path, isDirectory) => {
    let verdict: boolean | undefined
    for (const rule of rules) {
      if (rule.directoryOnly && !isDirectory) continue
      if (rule.expression.test(path)) verdict = !rule.negated
    }
    return verdict
  }
}

function compileRule(raw: string): Rule | undefined {
  // Trailing spaces are not part of a pattern unless escaped, which is how
  // git reads them and how editors keep leaving them.
  let line = raw.replace(/(?<!\\)\s+$/, '')
  if (line === '' || line.startsWith('#')) return undefined

  const negated = line.startsWith('!')
  if (negated) line = line.slice(1)

  const directoryOnly = line.endsWith('/')
  if (directoryOnly) line = line.slice(0, -1)

  // A slash anywhere but the end anchors the pattern to this directory; a
  // pattern without one matches a name at any depth.
  const anchored = line.includes('/')
  if (line.startsWith('/')) line = line.slice(1)

  const source = translate(line)
  return {
    expression: new RegExp(anchored ? `^${source}$` : `(?:^|/)${source}$`),
    negated,
    directoryOnly,
  }
}

/** The glob's meaning as a regular expression, one character at a time. */
function translate(glob: string): string {
  let out = ''
  let at = 0

  while (at < glob.length) {
    const char = glob[at] as string

    if (char === '\\' && at + 1 < glob.length) {
      out += literal(glob[at + 1] as string)
      at += 2
    } else if (glob.startsWith('**', at)) {
      const star = doubleStar(glob, at)
      out += star.source
      at += star.length
    } else if (char === '[') {
      const bracket = characterClass(glob, at)
      out += bracket.source
      at += bracket.length
    } else {
      out += SINGLE[char] ?? literal(char)
      at += 1
    }
  }

  return out
}

const SINGLE: Record<string, string> = { '*': '[^/]*', '?': '[^/]' }

/** What a `**` at this position means, and how much of the glob it takes. */
function doubleStar(glob: string, at: number): { source: string; length: number } {
  const leading = at === 0 || glob[at - 1] === '/'
  // `**/` — any number of directories, including none.
  if (leading && glob[at + 2] === '/') return { source: '(?:.*/)?', length: 3 }
  // A trailing `/**` — everything inside.
  if (leading && at + 2 === glob.length) return { source: '.*', length: 2 }
  // `a**b` is just `a*b` to git.
  return { source: '[^/]*', length: 2 }
}

/** A `[...]` class, or a literal bracket when it never closes. */
function characterClass(glob: string, at: number): { source: string; length: number } {
  const close = glob.indexOf(']', at + 1)
  if (close === -1) return { source: '\\[', length: 1 }

  const body = glob.slice(at + 1, close)
  return {
    source: `[${body.startsWith('!') ? `^${body.slice(1)}` : body}]`,
    length: close + 1 - at,
  }
}

function literal(char: string): string {
  return /[.*+?^${}()|[\]\\/]/.test(char) ? `\\${char}` : char
}
