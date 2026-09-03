import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { symbolsTool } from './symbols.ts'

let root: string

function make(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-symbols-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = async (input: object) =>
  await symbolsTool.execute(input, {
    cwd: root,
    agentId: 'test',
    signal: new AbortController().signal,
  })

describe('symbols', () => {
  test('finds where a name is declared and not where it is merely used', async () => {
    make({
      'src/a.ts': [
        'export function taskOf(id: string) {}', // 1: declared
        'const t = taskOf("x")', // 2: used
        'if (taskOf) {}', // 3: used
      ].join('\n'),
      'src/b.ts': [
        "import { taskOf } from './a.ts'", // 1: imported, not declared
        'taskOf("y")', // 2: used
      ].join('\n'),
    })

    const { content } = await run({ name: 'taskOf' })

    expect(content).toBe('src/a.ts:1: export function taskOf(id: string) {}')
  })

  test('knows every way a name can be declared', async () => {
    make({
      'a.ts': [
        'const x = 1',
        'let x = 2',
        'var x = 3',
        'class x {}',
        'type x = string',
        'interface x {}',
        'enum x { A }',
        'export default function x() {}',
        'function* x() {}',
        'for (const x of xs) {}',
        'namespace x {}',
      ].join('\n'),
    })

    const { content } = await run({ name: 'x' })

    const found = content.split('\n').map((line) => line.split(':')[1])
    expect(found).toEqual(['1', '2', '3', '4', '5', '6', '7', '8', '9', '10', '11'])
  })

  test('finds a method or a function-valued property inside a class', async () => {
    make({
      'a.ts': [
        'class Store {',
        '  private async load(id: string): Promise<void> {', // 2: method
        '  }',
        '  static load<T>(x: T) {', // 4: generic method
        '  }',
        '  load = async (id: string) => {', // 6: arrow property
        '  }',
        '  get load() {', // 8: accessor
        '  }',
        '  run() {',
        '    load(id)', // 11: a call, not a declaration
        '    load("x", () => {', // 12: a call with a callback
        '    })',
        '    this.load(id)',
        '  }',
        '}',
        'const obj = {',
        '  load(a: number) {', // 18: object method
        '  },',
        '}',
      ].join('\n'),
    })

    const { content } = await run({ name: 'load' })

    const found = content.split('\n').map((line) => line.split(':')[1])
    expect(found).toEqual(['2', '4', '6', '8', '18'])
  })

  test('matches the whole identifier, not a name that contains it', async () => {
    make({ 'a.ts': 'function taskOfAgent() {}\nfunction taskOf() {}\nconst myTaskOf = 1\n' })

    const { content } = await run({ name: 'taskOf' })

    expect(content).toBe('a.ts:2: function taskOf() {}')
  })

  test('ignores a declaration that is quoted in a string or a comment', async () => {
    // This repository's own tests quote declarations, so `function taskOf`
    // inside a string used to be reported next to the real one.
    make({
      'a.ts': [
        '// function needle() {}',
        ' * const needle = 1',
        'expect(s).toBe("function needle() {}")',
        "const fixture = 'export const needle = 1'",
        'export function needle() {}',
      ].join('\n'),
    })

    const { content } = await run({ name: 'needle' })

    expect(content).toBe('a.ts:5: export function needle() {}')
  })

  test('ignores a type-only import that looks like a type declaration', async () => {
    make({
      'a.ts': [
        "import type Foo from './foo.ts'",
        'import {',
        '  type Foo,',
        "} from './foo.ts'",
      ].join('\n'),
      'foo.ts': 'export type Foo = { a: 1 }\n',
    })

    const { content } = await run({ name: 'Foo' })

    expect(content).toBe('foo.ts:1: export type Foo = { a: 1 }')
  })

  test('looks only at source files, and not in what nobody means', async () => {
    make({
      'src/a.ts': 'function needle() {}\n',
      'node_modules/pkg/index.js': 'function needle() {}\n',
      'dist/a.js': 'function needle() {}\n',
      'docs/a.md': 'function needle() {}\n',
    })

    const { content } = await run({ name: 'needle' })

    expect(content).toBe('src/a.ts:1: function needle() {}')
  })

  test('searches under a directory when given one', async () => {
    make({ 'src/a.ts': 'function needle() {}\n', 'other/b.ts': 'function needle() {}\n' })

    const { content } = await run({ name: 'needle', path: 'src' })

    expect(content).toContain('src/a.ts')
    expect(content).not.toContain('other')
  })

  test('says so plainly when nothing declares the name', async () => {
    make({ 'a.ts': 'needle()\n' })

    const { content, isError } = await run({ name: 'needle' })

    expect(content).toContain('no declaration of needle')
    expect(isError).toBeUndefined()
  })

  test('stops at a hundred and says it stopped', async () => {
    const files: Record<string, string> = {}
    for (let at = 0; at < 110; at += 1) files[`f${at}.ts`] = 'const needle = 1\n'
    make(files)

    const { content } = await run({ name: 'needle' })

    expect(content.split('\n').filter((line) => line.includes('const needle')).length).toBe(100)
    expect(content).toContain('more')
  })

  test('refuses a name that is not an identifier, before searching', async () => {
    make({ 'a.ts': '' })

    const { content, isError } = await run({ name: 'a.b(' })

    expect(isError).toBe(true)
    expect(content).toContain('identifier')
  })

  test('never leaves the workspace', async () => {
    make({ 'a.ts': '' })

    expect((await run({ name: 'x', path: '../..' })).content).toContain('escapes the workspace')
  })
})
