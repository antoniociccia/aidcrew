import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ToolContext } from '@aidcrew/core'
import { editTool, readTool, writeTool } from './tools.ts'

let root: string
let context: ToolContext

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), 'aidcrew-fs-')))
  context = { cwd: root, signal: new AbortController().signal, agentId: 'coder' }
})

afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('read', () => {
  test('numbers the lines so the model can refer to them', async () => {
    writeFileSync(join(root, 'a.ts'), 'first\nsecond\n')

    const output = await readTool.execute({ path: 'a.ts' }, context)

    expect(output.content).toBe('1\tfirst\n2\tsecond')
    expect(output.isError).toBeFalsy()
  })

  test('does not report a phantom line for a trailing newline', async () => {
    writeFileSync(join(root, 'a.ts'), 'only\n')

    const output = await readTool.execute({ path: 'a.ts' }, context)

    expect(output.content).toBe('1\tonly')
  })

  test('reads a window of a large file', async () => {
    writeFileSync(
      join(root, 'big.txt'),
      Array.from({ length: 100 }, (_, i) => `L${i + 1}`).join('\n'),
    )

    const output = await readTool.execute({ path: 'big.txt', offset: 10, limit: 2 }, context)

    expect(output.content).toStartWith('10\tL10\n11\tL11')
    // The model must be told the file continues, or it will assume it read all of it.
    expect(output.content).toMatch(/89 more lines/)
  })

  test('says how many lines there are and where to continue', async () => {
    const lines = Array.from({ length: 2500 }, (_, at) => `line ${at + 1}`).join('\n')
    writeFileSync(join(root, 'big.txt'), `${lines}\n`)

    const output = await readTool.execute({ path: 'big.txt' }, context)

    expect(output.content).toContain('500 more lines')
    expect(output.content).toContain('2500 in all')
    expect(output.content).toContain('offset=2001')
  })

  test('says a file is binary rather than printing it', async () => {
    writeFileSync(join(root, 'blob.bin'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]))

    const output = await readTool.execute({ path: 'blob.bin' }, context)

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/binary/i)
    expect(output.content).toContain('7 bytes')
  })

  test('says the file is empty instead of returning nothing', async () => {
    writeFileSync(join(root, 'empty.txt'), '')

    const output = await readTool.execute({ path: 'empty.txt' }, context)

    expect(output.content).toMatch(/empty/i)
  })

  test('reports a missing file as an error the model can act on', async () => {
    const output = await readTool.execute({ path: 'nope.ts' }, context)

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/nope\.ts/)
  })

  test('refuses to read outside the workspace', async () => {
    const output = await readTool.execute({ path: '/etc/passwd' }, context)

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/workspace/)
  })

  test('rejects arguments that do not match the schema', async () => {
    const output = await readTool.execute({ wrong: 1 }, context)

    expect(output.isError).toBe(true)
  })
})

describe('write', () => {
  test('creates the file and any missing parent directories', async () => {
    const output = await writeTool.execute({ path: 'a/b/c.ts', content: 'hi' }, context)

    expect(output.isError).toBeFalsy()
    expect(readFileSync(join(root, 'a/b/c.ts'), 'utf8')).toBe('hi')
  })

  test('overwrites an existing file', async () => {
    writeFileSync(join(root, 'a.ts'), 'old')

    await writeTool.execute({ path: 'a.ts', content: 'new' }, context)

    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('new')
  })

  test('refuses to write outside the workspace', async () => {
    const output = await writeTool.execute({ path: '../escaped.ts', content: 'x' }, context)

    expect(output.isError).toBe(true)
  })
})

describe('edit', () => {
  test('replaces the one occurrence it was given', async () => {
    writeFileSync(join(root, 'a.ts'), 'const a = 1\nconst b = 2\n')

    const output = await editTool.execute(
      { path: 'a.ts', oldString: 'const b = 2', newString: 'const b = 3' },
      context,
    )

    expect(output.isError).toBeFalsy()
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('const a = 1\nconst b = 3\n')
  })

  test('refuses an ambiguous match instead of picking one', async () => {
    writeFileSync(join(root, 'a.ts'), 'x = 1\nx = 1\n')

    const output = await editTool.execute(
      { path: 'a.ts', oldString: 'x = 1', newString: 'x = 2' },
      context,
    )

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/2 times|twice|ambiguous/i)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('x = 1\nx = 1\n')
  })

  test('replaces every occurrence when explicitly asked', async () => {
    writeFileSync(join(root, 'a.ts'), 'x = 1\nx = 1\n')

    const output = await editTool.execute(
      { path: 'a.ts', oldString: 'x = 1', newString: 'x = 2', replaceAll: true },
      context,
    )

    expect(output.isError).toBeFalsy()
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe('x = 2\nx = 2\n')
  })

  test('reports a string that is not in the file', async () => {
    writeFileSync(join(root, 'a.ts'), 'hello')

    const output = await editTool.execute(
      { path: 'a.ts', oldString: 'goodbye', newString: 'x' },
      context,
    )

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/not found/i)
  })

  test('edits a match that differs only in whitespace, and says so', async () => {
    // Watched, three times in one run: the model quoted a line with spaces
    // where the file had a tab, was told "oldString not found", and spent a
    // turn re-reading the file to quote it again. Indentation is the one
    // thing a model gets wrong on purpose — it cannot see a tab.
    writeFileSync(join(root, 'a.ts'), 'if (x) {\n\tconst a = 1\n\treturn a\n}\n')

    const output = await editTool.execute(
      {
        path: 'a.ts',
        oldString: '  const a = 1\n  return a',
        newString: '  const a = 2\n  return a * 2',
      },
      context,
    )

    expect(output.isError).toBeFalsy()
    expect(output.content).toMatch(/whitespace/i)
    expect(readFileSync(join(root, 'a.ts'), 'utf8')).toBe(
      'if (x) {\n\tconst a = 2\n\treturn a * 2\n}\n',
    )
  })

  test('names the nearest line when the string is not there at all', async () => {
    writeFileSync(join(root, 'a.ts'), 'const a = 1\nconst total = a + 2\nexport { total }\n')

    const output = await editTool.execute(
      { path: 'a.ts', oldString: 'const total = a + 3\nexport { total }', newString: 'x' },
      context,
    )

    expect(output.isError).toBe(true)
    expect(output.content).toMatch(/not found/)
    expect(output.content).toContain('line 2')
    expect(output.content).toContain('const total = a + 2')
  })

  test('rejects an edit that changes nothing', async () => {
    writeFileSync(join(root, 'a.ts'), 'hello')

    const output = await editTool.execute(
      { path: 'a.ts', oldString: 'hello', newString: 'hello' },
      context,
    )

    expect(output.isError).toBe(true)
  })

  test('inserts the replacement verbatim, even when it holds $ patterns', async () => {
    // JavaScript's String.replace reads `$&`, `` $` ``, `$'` and `$$` in the
    // replacement string as substitution patterns. Editing a shell script to
    // insert `printf $'\n'; echo pid=$$` silently duplicated the rest of the
    // file into the line (that is `$'`) and turned `$$` into a single `$`, all
    // reported as a clean "1 replacement". The replacement must go in as typed.
    writeFileSync(join(root, 'run.sh'), 'echo start\nPLACEHOLDER\necho end\n')

    const insertion = "printf $'\\n'; echo pid=$$; echo $&"
    const output = await editTool.execute(
      { path: 'run.sh', oldString: 'PLACEHOLDER', newString: insertion },
      context,
    )

    expect(output.isError).toBeFalsy()
    expect(readFileSync(join(root, 'run.sh'), 'utf8')).toBe(`echo start\n${insertion}\necho end\n`)
  })
})

describe('tool definitions', () => {
  test('expose a json schema built from the same shape they validate with', () => {
    for (const tool of [readTool, writeTool, editTool]) {
      expect(tool.inputSchema).toHaveProperty('type', 'object')
      expect(tool.inputSchema).toHaveProperty('properties')
    }
  })

  test('keep descriptions short, because they all sit in the system prompt', () => {
    for (const tool of [readTool, writeTool, editTool]) {
      expect(tool.description.length).toBeLessThan(400)
    }
  })
})
