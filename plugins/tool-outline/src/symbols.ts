import { defineTool } from '@aidcrew/plugin-sdk'
import { resolveInWorkspace } from '@aidcrew/tool-fs'
import { z } from 'zod'
import { displayPath, readIfText, SOURCE_GLOB, walk } from './walk.ts'

/**
 * Where a name is declared, as opposed to mentioned.
 *
 * `grep taskOf` answers with every call, import and comment, and for a common
 * name that is forty lines of which one is the answer. This asks the narrower
 * question with regular expressions: a keyword declaration (`function x`,
 * `const x`, `class x`, `type x =`…) anywhere on a line, or a name at member
 * position — the start of a line, after modifiers — opening a body. The second
 * is a best effort: a call at the start of a line is told apart from a method
 * by what the line ends with, which is right for formatted code and wrong for
 * nothing anyone has shown it yet.
 */

/** Enough to see every declaration of a common name; few enough to read. */
const LIMIT = 100
const MAX_LINE_LENGTH = 400

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/
const MODIFIERS =
  '(?:(?:public|private|protected|static|readonly|override|async|abstract|get|set|declare)\\s+)*'

export const symbolsTool = defineTool({
  name: 'symbols',
  reads: true,
  description:
    'Where an identifier is declared — function, const, class, type, interface, enum or method — ' +
    'across the workspace, as path:line. Use it instead of grep when you want the definition of ' +
    'a name rather than every mention of it; grep for patterns, symbols for one name.',
  schema: z.object({
    name: z.string().describe('The identifier, exactly as written in code.'),
    path: z.string().optional().describe('Directory to search in, relative to the workspace.'),
  }),
  async run({ name, path = '.' }, { cwd }) {
    if (!IDENTIFIER.test(name)) {
      return {
        content:
          `"${name}" is not an identifier; symbols finds the declarations of one name. ` +
          'Use grep for a pattern.',
        isError: true,
      }
    }

    const root = resolveInWorkspace(cwd, path)
    const { found, cut } = await scan(root, cwd, name)

    if (found.length === 0) {
      return { content: `no declaration of ${name} under ${path}; grep finds its mentions` }
    }

    return {
      content: cut
        ? `${found.join('\n')}\n... and more, past the limit of ${LIMIT}`
        : found.join('\n'),
    }
  },
})

/** Every declaring line under `root`, until the limit says enough. */
async function scan(
  root: string,
  cwd: string,
  name: string,
): Promise<{ found: string[]; cut: boolean }> {
  const declares = matchers(name)
  const found: string[] = []

  for await (const file of walk(root, SOURCE_GLOB)) {
    const text = await readIfText(file)
    // Cheap, and most files do not mention the name at all.
    if (text === undefined || !text.includes(name)) continue

    const shown = displayPath(cwd, file)
    for (const [at, line] of text.split('\n').entries()) {
      if (!declares.some((declares) => declares(line))) continue
      if (found.length >= LIMIT) return { found, cut: true }
      found.push(`${shown}:${at + 1}: ${truncate(line.trim())}`)
    }
  }

  return { found, cut: false }
}

/**
 * The ways a line can declare `name`.
 *
 * Every matcher requires the whole identifier: `taskOf` is not found in
 * `taskOfAgent`, nor in `myTaskOf`. A type alias must be followed by `=` or
 * `<`, which is what keeps `import type Foo from` and a `type Foo,` line in a
 * multi-line import out of the answer. Keyword declarations are anchored at
 * the start of the line, behind the modifiers that can precede one: that is
 * what keeps a comment or a test string quoting `function taskOf` out too,
 * at the price of a declaration in the middle of a line, which formatted
 * code does not have.
 */
function matchers(name: string): ((line: string) => boolean)[] {
  const escaped = name.replace(/[$]/g, '\\$')
  const whole = `${escaped}(?![\\w$])`

  const keyword = new RegExp(
    `^\\s*(?:(?:export|default|declare|abstract|async)\\s+|for\\s*\\(\\s*)*(?:function\\s*\\*?\\s*|class\\s+|(?:const|let|var)\\s+|interface\\s+|enum\\s+|namespace\\s+)${whole}`,
  )
  const alias = new RegExp(`^\\s*(?:(?:export|declare)\\s+)*type\\s+${escaped}\\s*[=<]`)
  // A method, accessor or object-literal method: the name at member position,
  // its parameter list, and a body opening on the same line. `foo(function () {`
  // is a call and is refused by the lookahead; a call with an arrow callback
  // ends in `=> {` and is refused below.
  const method = new RegExp(
    `^\\s*${MODIFIERS}(?:\\*\\s*)?${escaped}\\s*(?:<[^>]*>)?\\s*\\((?![^)]*\\bfunction\\b).*\\{\\s*$`,
  )
  const callback = /=>\s*\{\s*$/
  // A function-valued property or field: `name = (…) =>`, `name: async …`.
  const property = new RegExp(
    `^\\s*${MODIFIERS}${escaped}\\s*[=:]\\s*(?:async\\b|function\\b|\\(|[\\w$]+\\s*=>)`,
  )

  return [
    (line) => keyword.test(line),
    (line) => alias.test(line),
    (line) => method.test(line) && !callback.test(line),
    (line) => property.test(line),
  ]
}

function truncate(line: string): string {
  return line.length > MAX_LINE_LENGTH ? `${line.slice(0, MAX_LINE_LENGTH)}…` : line
}
