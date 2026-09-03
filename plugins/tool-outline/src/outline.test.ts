import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { outlineTool } from './outline.ts'

let root: string

function make(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-outline-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = async (input: object) =>
  await outlineTool.execute(input, {
    cwd: root,
    agentId: 'test',
    signal: new AbortController().signal,
  })

const lines = (content: string) => content.split('\n')

describe('outline', () => {
  test('lists every kind of export with the line it is on, in file order', async () => {
    make({
      'a.ts': [
        'import { x } from "./x.ts"',
        'export function one() {}',
        'export async function two() {}',
        'export const three = 3',
        'export let four = 4',
        'export class Five {}',
        'export type Six = string',
        'export interface Seven {}',
        'export enum Eight { A }',
        'function notExported() {}',
        'export function* nine() {}',
      ].join('\n'),
    })

    const { content } = await run({ path: 'a.ts' })

    expect(lines(content)).toEqual([
      '2: function one',
      '3: function two',
      '4: const three',
      '5: let four',
      '6: class Five',
      '7: type Six',
      '8: interface Seven',
      '9: enum Eight',
      '11: function nine',
    ])
  })

  test('says "default" for a default export, with the name when it has one', async () => {
    make({
      'named-fn.ts': 'export default function main() {}\n',
      'named-class.ts': 'export default class App {}\n',
      'anonymous.ts': 'export default definePlugin({ name: "x" })\n',
      'anonymous-fn.ts': 'export default async function () {}\n',
    })

    expect((await run({ path: 'named-fn.ts' })).content).toBe('1: default main')
    expect((await run({ path: 'named-class.ts' })).content).toBe('1: default App')
    expect((await run({ path: 'anonymous.ts' })).content).toBe('1: default')
    expect((await run({ path: 'anonymous-fn.ts' })).content).toBe('1: default')
  })

  test('lists the names in an export list, keeping a rename visible', async () => {
    make({ 'a.ts': 'const a = 1\nconst b = 2\nexport { a, b as c }\n' })

    expect(lines((await run({ path: 'a.ts' })).content)).toEqual([
      '3: export a',
      '3: export b as c',
    ])
  })

  test('reads a multi-line export list, giving each name its own line number', async () => {
    // A line-at-a-time regex sees `export {` and nothing else; the names are
    // on the lines after it, and those are the lines worth reporting.
    make({
      'a.ts': ['const a = 1', 'const b = 2', 'export {', '  a,', '  b as c,', '}', ''].join('\n'),
    })

    expect(lines((await run({ path: 'a.ts' })).content)).toEqual([
      '4: export a',
      '5: export b as c',
    ])
  })

  test('says where a re-export comes from', async () => {
    make({
      'index.ts': [
        "export * from './all.ts'",
        "export * as ns from './ns.ts'",
        "export { x, y as z } from './some.ts'",
        "export type { T } from './types.ts'",
        'export {',
        '  p,',
        '  q,',
        "} from './multi.ts'",
      ].join('\n'),
    })

    expect(lines((await run({ path: 'index.ts' })).content)).toEqual([
      '1: re-export * from ./all.ts',
      '2: re-export * as ns from ./ns.ts',
      '3: re-export x from ./some.ts',
      '3: re-export y as z from ./some.ts',
      '4: re-export T from ./types.ts',
      '6: re-export p from ./multi.ts',
      '7: re-export q from ./multi.ts',
    ])
  })

  test('ignores an export that is inside a string or a comment', async () => {
    // The earlier attempt at this tool matched `export {` anywhere on a line,
    // so a test fixture or a comment quoting one produced phantom exports.
    // Anchoring at the start of the line is what stops that.
    make({
      'a.ts': [
        'const fixture = "export { fake } from \'./nowhere\'"',
        "// export { commented } from './nowhere'",
        "/* export * from './nowhere' */",
        'const s2 = `export function inString() {}`',
        'export const real = 1',
      ].join('\n'),
    })

    const { content } = await run({ path: 'a.ts' })

    expect(content).toBe('5: const real')
    expect(content).not.toContain('nowhere')
  })

  test('strips the modifiers that sit between export and the kind', async () => {
    make({
      'a.ts': [
        'export declare function f(): void',
        'export abstract class C {}',
        'export const enum E { A }',
        'export declare const k: number',
      ].join('\n'),
    })

    expect(lines((await run({ path: 'a.ts' })).content)).toEqual([
      '1: function f',
      '2: class C',
      '3: enum E',
      '4: const k',
    ])
  })

  test('names each binding of a destructured constant', async () => {
    make({ 'a.ts': 'export const { a, b: c } = obj\nexport const [d, e] = arr\n' })

    expect(lines((await run({ path: 'a.ts' })).content)).toEqual([
      '1: const a',
      '1: const c',
      '2: const d',
      '2: const e',
    ])
  })

  test('understands CommonJS exports in a JavaScript file', async () => {
    make({ 'a.cjs': 'exports.helper = () => 1\nmodule.exports = { helper }\n' })

    expect(lines((await run({ path: 'a.cjs' })).content)).toEqual([
      '1: export helper',
      '2: default',
    ])
  })

  test('says so when a file exports nothing, rather than returning nothing', async () => {
    make({ 'a.ts': 'const a = 1\nfunction b() {}\n' })

    const { content, isError } = await run({ path: 'a.ts' })

    expect(content).toContain('no exports')
    expect(content).toContain('a.ts')
    expect(isError).toBeUndefined()
  })

  test('stops at a limit inside one file and says how much was left', async () => {
    const many = Array.from({ length: 520 }, (_, at) => `export const x${at} = ${at}`).join('\n')
    make({ 'big.ts': many })

    const { content } = await run({ path: 'big.ts' })

    expect(lines(content).filter((line) => line.includes('const x')).length).toBe(500)
    expect(content).toContain('20 more')
  })

  test('outlines several files under a glob, with a header for each', async () => {
    make({
      'src/a.ts': 'export const a = 1\n',
      'src/b.ts': 'export function b() {}\n',
      'src/c.md': '# not code\n',
      'node_modules/pkg/index.ts': 'export const hidden = 1\n',
    })

    const { content } = await run({ path: 'src', glob: '**/*.ts' })

    // The header is the path as the model would pass it back, nothing more.
    expect(content).toMatch(/^src\/a\.ts$/m)
    expect(content).toContain('1: const a')
    expect(content).toMatch(/^src\/b\.ts$/m)
    expect(content).toContain('1: function b')
    expect(content).not.toContain('c.md')
    expect(content).not.toContain('hidden')
  })

  test('outlines the source files of a directory when given no glob', async () => {
    make({
      'pkg/src/a.ts': 'export const a = 1\n',
      'pkg/src/b.tsx': 'export function B() {}\n',
      'pkg/README.md': 'export nothing\n',
    })

    const { content } = await run({ path: 'pkg' })

    expect(content).toContain('const a')
    expect(content).toContain('function B')
    expect(content).not.toContain('README')
  })

  test('stops at fifty files and says how many it did not open', async () => {
    const files: Record<string, string> = {}
    for (let at = 0; at < 53; at += 1)
      files[`src/f${String(at).padStart(2, '0')}.ts`] = 'export const v = 1\n'
    make(files)

    const { content } = await run({ path: 'src', glob: '*.ts' })

    expect(content.split('const v').length - 1).toBe(50)
    expect(content).toContain('3 more files')
  })

  test('refuses a glob given with a file, since a glob needs a directory', async () => {
    make({ 'a.ts': 'export const a = 1\n' })

    const { content, isError } = await run({ path: 'a.ts', glob: '*.ts' })

    expect(isError).toBe(true)
    expect(content).toContain('directory')
  })

  test('never leaves the workspace, by path or by glob', async () => {
    make({ 'a.ts': 'export const a = 1\n' })

    expect((await run({ path: '../../etc/passwd' })).content).toContain('escapes the workspace')

    const { content, isError } = await run({ path: '.', glob: '../*.ts' })
    expect(isError).toBe(true)
    expect(content).toContain('workspace')
  })

  test('returns a failure the model can read for a file that is not there', async () => {
    make({ 'a.ts': '' })

    const { content, isError } = await run({ path: 'missing.ts' })

    expect(isError).toBe(true)
    expect(content).toContain('missing.ts')
  })
})
