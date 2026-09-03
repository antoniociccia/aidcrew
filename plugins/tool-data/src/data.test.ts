import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { jsonTool, parseKey, tomlTool } from './data.ts'

let root: string

function make(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-data-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

const execute = (tool: typeof jsonTool | typeof tomlTool, input: object) =>
  tool.execute(input, { cwd: root, agentId: 'test', signal: new AbortController().signal })
const run = async (tool: typeof jsonTool | typeof tomlTool, input: object) =>
  (await execute(tool, input)).content

const PACKAGE = JSON.stringify({
  name: 'demo',
  version: 3,
  private: true,
  main: null,
  dependencies: { zod: '^4.4.3', react: '^19' },
  agents: [
    { name: 'alpha', model: 'a' },
    { name: 'beta', model: 'b' },
  ],
  nested: { list: [1, 2, { deep: 'found' }] },
})

describe('json', () => {
  test('returns a string as plain text, not as a quoted JSON string', async () => {
    make({ 'package.json': PACKAGE })

    expect(await run(jsonTool, { path: 'package.json', key: 'dependencies.zod' })).toBe('^4.4.3')
  })

  test('walks array indexes and nested keys', async () => {
    make({ 'package.json': PACKAGE })

    expect(await run(jsonTool, { path: 'package.json', key: 'agents[0].name' })).toBe('alpha')
    expect(await run(jsonTool, { path: 'package.json', key: 'nested.list[2].deep' })).toBe('found')
  })

  test('returns numbers, booleans and null as words', async () => {
    make({ 'package.json': PACKAGE })

    expect(await run(jsonTool, { path: 'package.json', key: 'version' })).toBe('3')
    expect(await run(jsonTool, { path: 'package.json', key: 'private' })).toBe('true')
    expect(await run(jsonTool, { path: 'package.json', key: 'main' })).toBe('null')
  })

  test('returns an object or an array as readable JSON', async () => {
    make({ 'package.json': PACKAGE })

    expect(await run(jsonTool, { path: 'package.json', key: 'dependencies' })).toBe(
      '{\n  "zod": "^4.4.3",\n  "react": "^19"\n}',
    )
    expect(await run(jsonTool, { path: 'package.json', key: 'nested.list' })).toBe(
      '[\n  1,\n  2,\n  {\n    "deep": "found"\n  }\n]',
    )
  })

  test('with no key, shows the top-level keys and what each holds', async () => {
    make({ 'package.json': PACKAGE })

    const shown = await run(jsonTool, { path: 'package.json' })

    expect(shown).toContain('name: string')
    expect(shown).toContain('version: number')
    expect(shown).toContain('private: boolean')
    expect(shown).toContain('main: null')
    expect(shown).toContain('dependencies: object (2 keys)')
    expect(shown).toContain('agents: array (2 items)')
  })

  test('describes a top-level array when there are no keys to list', async () => {
    make({ 'list.json': '[1, 2, 3]' })

    expect(await run(jsonTool, { path: 'list.json' })).toContain('array (3 items)')
  })

  test('says which part of a missing path exists and which does not, with the keys there', async () => {
    make({ 'package.json': PACKAGE })

    const result = await execute(jsonTool, { path: 'package.json', key: 'dependencies.zid' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('dependencies exists')
    expect(result.content).toContain('"zid"')
    expect(result.content).toContain('zod')
    expect(result.content).not.toContain('undefined')
  })

  test('names the top level when the first part is missing', async () => {
    make({ 'package.json': PACKAGE })

    const result = await execute(jsonTool, { path: 'package.json', key: 'nothing.here' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('top level')
    expect(result.content).toContain('dependencies')
  })

  test('says how long an array is when the index is past its end', async () => {
    make({ 'package.json': PACKAGE })

    const result = await execute(jsonTool, { path: 'package.json', key: 'agents[5].name' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('2 items')
    expect(result.content).toContain('agents[5]')
  })

  test('says what a value is when the path tries to go inside something that has no inside', async () => {
    make({ 'package.json': PACKAGE })

    const result = await execute(jsonTool, { path: 'package.json', key: 'name.first' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('name is a string')
  })

  test('reaches a key that contains a dot when it is written in brackets', async () => {
    make({ 'tsconfig.json': '{"paths": {"@x/core/*": ["./core/*"]}}' })

    expect(await run(jsonTool, { path: 'tsconfig.json', key: 'paths["@x/core/*"][0]' })).toBe(
      './core/*',
    )
  })

  test('refuses a key it cannot parse, and says what the syntax is', async () => {
    make({ 'package.json': PACKAGE })

    const result = await execute(jsonTool, { path: 'package.json', key: 'a..b' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('a..b')
    expect(result.content).toContain('agents[0].name')
  })

  test('says a file is not valid JSON and where parsing stopped', async () => {
    make({ 'broken.json': '{\n  "a": 1,\n  "b": tru\n}\n' })

    const result = await execute(jsonTool, { path: 'broken.json', key: 'a' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('not valid JSON')
    expect(result.content).toContain('line 3')
  })

  test('still says where, on a runtime that no longer says where', async () => {
    // Bun 1.4 removed the {line, column} it used to hang off a parse error —
    // what is on the error now is where the parse call is, the same numbers
    // for every file — and this test went on passing on the old one for a
    // fortnight while the tool said nothing useful on the new one.
    make({ 'late.json': '{\n\n\n\n\n  "b": tru\n}\n' })

    const result = await execute(jsonTool, { path: 'late.json', key: 'b' })

    expect(result.content).toContain('line 6')
  })

  test('accepts comments and trailing commas, which tsconfig files have', async () => {
    make({ 'tsconfig.json': '{\n  // strict, always\n  "strict": true,\n}\n' })

    expect(await run(jsonTool, { path: 'tsconfig.json', key: 'strict' })).toBe('true')
  })

  test('accepts a byte order mark', async () => {
    make({ 'bom.json': '﻿{"a": 1}' })

    expect(await run(jsonTool, { path: 'bom.json', key: 'a' })).toBe('1')
  })

  test('bounds a large value and says it did', async () => {
    const big: Record<string, string> = {}
    for (let at = 0; at < 5_000; at += 1) big[`key-${at}`] = 'x'.repeat(20)
    make({ 'big.json': JSON.stringify(big) })

    const shown = await run(jsonTool, { path: 'big.json', key: '' })
    const value = await run(jsonTool, { path: 'big.json', key: 'key-4999' })
    const whole = await run(jsonTool, { path: 'big.json', key: '.' })

    expect(value).toBe('x'.repeat(20))
    expect(shown.length).toBeLessThan(60_000)
    expect(shown).toContain('5000 keys')
    expect(whole.length).toBeLessThan(60_000)
    expect(whole).toContain('cut')
  })

  test('says when the file does not exist, and refuses a directory', async () => {
    make({ 'src/a.json': '{}' })

    const missing = await execute(jsonTool, { path: 'nowhere.json' })
    expect(missing.isError).toBe(true)
    expect(missing.content).toContain('nowhere.json')

    const directory = await execute(jsonTool, { path: 'src' })
    expect(directory.isError).toBe(true)
    expect(directory.content).toContain('directory')
  })

  test('never leaves the workspace, however the path is written', async () => {
    make({ 'a.json': '{}' })

    expect(await run(jsonTool, { path: '../../etc/passwd' })).toContain('escapes the workspace')
  })
})

describe('toml', () => {
  const CONFIG = [
    'name = "demo"',
    'retries = 3',
    '',
    '[provider]',
    'model = "big-one"',
    'stream = true',
    '',
    '[[agents]]',
    'name = "alpha"',
    '',
    '[[agents]]',
    'name = "beta"',
    'tools = ["read", "grep"]',
    '',
  ].join('\n')

  test('reads one value out of a table, by the same path syntax as json', async () => {
    make({ 'config.toml': CONFIG })

    expect(await run(tomlTool, { path: 'config.toml', key: 'provider.model' })).toBe('big-one')
    expect(await run(tomlTool, { path: 'config.toml', key: 'agents[1].tools[0]' })).toBe('read')
    expect(await run(tomlTool, { path: 'config.toml', key: 'retries' })).toBe('3')
    expect(await run(tomlTool, { path: 'config.toml', key: 'provider.stream' })).toBe('true')
  })

  test('returns a table as JSON', async () => {
    make({ 'config.toml': CONFIG })

    expect(await run(tomlTool, { path: 'config.toml', key: 'provider' })).toBe(
      '{\n  "model": "big-one",\n  "stream": true\n}',
    )
  })

  test('with no key, shows the top-level keys and what each holds', async () => {
    make({ 'config.toml': CONFIG })

    const shown = await run(tomlTool, { path: 'config.toml' })

    expect(shown).toContain('name: string')
    expect(shown).toContain('provider: object (2 keys)')
    expect(shown).toContain('agents: array (2 items)')
  })

  test('says which part of a missing path exists and which does not', async () => {
    make({ 'config.toml': CONFIG })

    const result = await execute(tomlTool, { path: 'config.toml', key: 'provider.temperature' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('provider exists')
    expect(result.content).toContain('"temperature"')
    expect(result.content).toContain('model')
  })

  test('says a file is not valid TOML and where parsing stopped', async () => {
    make({ 'broken.toml': 'name = "demo"\nlist = [1,\n' })

    const result = await execute(tomlTool, { path: 'broken.toml', key: 'name' })

    expect(result.isError).toBe(true)
    expect(result.content).toContain('not valid TOML')
    expect(result.content).toContain('line 2')
  })

  test('blames the line the file stops parsing at, not the one that opened it', async () => {
    // The obvious way to find the line is the first one that fails on its own,
    // and it is wrong: an array written over three lines fails on two of them
    // while being perfectly valid, so a mistake underneath it would be blamed
    // on the bracket above.
    make({ 'later.toml': 'list = [\n  1,\n]\nthis is not a key\n' })

    const result = await execute(tomlTool, { path: 'later.toml', key: 'list' })

    expect(result.content).toContain('line 4')
  })

  test('never leaves the workspace, however the path is written', async () => {
    make({ 'a.toml': '' })

    expect(await run(tomlTool, { path: '/etc/hosts' })).toContain('escapes the workspace')
  })
})

describe('parseKey', () => {
  test.each([
    ['dependencies.zod', ['dependencies', 'zod']],
    ['agents[0].name', ['agents', 0, 'name']],
    ['a.b[2].c', ['a', 'b', 2, 'c']],
    ['list[0][1]', ['list', 0, 1]],
    ['paths["a.b/*"].x', ['paths', 'a.b/*', 'x']],
    ["paths['q'].x", ['paths', 'q', 'x']],
    ['scripts.build:all', ['scripts', 'build:all']],
    ['', []],
    ['.', []],
  ])('%s → %j', (key, expected) => {
    expect(parseKey(key)).toEqual(expected)
  })

  test.each(['a..b', 'a[x]', 'a[', '[0', 'a.', '.a', 'a["b]'])('refuses %s', (key) => {
    expect(parseKey(key)).toBeUndefined()
  })
})
