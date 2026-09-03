import { afterEach, describe, expect, test } from 'bun:test'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Tool } from '@aidcrew/core'
import { awkTool, lsofTool, wcTool } from './unix.ts'

let root: string

function make(files: Record<string, string>): string {
  root = mkdtempSync(join(tmpdir(), 'aidcrew-unix-'))
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, body)
  }
  return root
}

afterEach(() => rmSync(root, { recursive: true, force: true }))

const run = async (tool: Tool, input: object) =>
  (await tool.execute(input, { cwd: root, agentId: 'test', signal: new AbortController().signal }))
    .content as string

describe('wc', () => {
  test('counts lines, words and characters', async () => {
    make({ 'a.txt': 'one two\nthree\n' })

    const counted = await run(wcTool, { path: 'a.txt' })

    expect(counted).toContain('2 lines')
    expect(counted).toContain('3 words')
  })

  test('counts every file a glob names, and totals them', async () => {
    make({ 'a.txt': 'x\n', 'b.txt': 'y\nz\n' })

    const counted = await run(wcTool, { path: '*.txt' })

    expect(counted).toContain('a.txt')
    expect(counted).toContain('b.txt')
    expect(counted).toContain('total')
  })

  test('a file with no trailing newline still has its last line counted', async () => {
    make({ 'a.txt': 'one\ntwo' })

    expect(await run(wcTool, { path: 'a.txt' })).toContain('2 lines')
  })

  test('stays inside the workspace', async () => {
    make({ 'a.txt': 'x\n' })

    expect(await run(wcTool, { path: '/etc/passwd' })).toContain('escapes the workspace')
  })
})

describe('awk', () => {
  test('runs a program over a file and returns what it printed', async () => {
    make({ 'data.csv': 'alice,30\nbob,41\n' })

    const output = await run(awkTool, { program: '-F, {print $2}', path: 'data.csv' })

    expect(output.split('\n')).toEqual(['30', '41'])
  })

  test('refuses a program that would write to the filesystem', async () => {
    make({ 'data.csv': 'x\n' })

    // awk can redirect and can shell out. This tool reads; anything that
    // changes the machine goes through bash, where the guards can see it.
    const refused = await run(awkTool, { program: '{print > "/tmp/out"}', path: 'data.csv' })

    expect(refused).toContain('only reads')
  })

  test('refuses a redirection into a variable, not just into a quoted name', async () => {
    const root = make({ 'data.csv': 'x\n' })

    // The obvious pattern catches `> "file"` and misses `> file`, which awk
    // resolves at run time — so the check has to be about redirecting at all,
    // not about what the destination looks like.
    const refused = await run(awkTool, {
      program: '{ out = "escaped.txt"; print $1 > out }',
      path: 'data.csv',
    })

    expect(refused).toContain('only reads')
    expect(await Bun.file(join(root, 'escaped.txt')).exists()).toBe(false)
  })

  test('still allows a comparison, which is not a redirection', async () => {
    make({ 'n.txt': '3\n9\n' })

    expect(await run(awkTool, { program: '$1 > 5 {print $1}', path: 'n.txt' })).toBe('9')
  })

  test('refuses a program that would run a command', async () => {
    make({ 'data.csv': 'x\n' })

    for (const program of ['{system("rm -rf /")}', '{ "id" | getline x; print x }']) {
      expect(await run(awkTool, { program, path: 'data.csv' })).toContain('only reads')
    }
  })

  test('stays inside the workspace', async () => {
    make({ 'a.txt': 'x\n' })

    expect(await run(awkTool, { program: '{print}', path: '/etc/passwd' })).toContain(
      'escapes the workspace',
    )
  })

  test('reports what awk itself complained about', async () => {
    make({ 'a.txt': 'x\n' })

    const broken = await run(awkTool, { program: '{print $1', path: 'a.txt' })

    expect(broken.length).toBeGreaterThan(0)
  })

  test('refuses -f, which runs a whole program from a file the agent wrote', async () => {
    // `-f script.awk` was accepted as a flag, so awk executed a program file
    // the agent had just written — `BEGIN { system(...) }` ran with no
    // approval. Only -F and -v are flags here; every other, -f among them, is
    // refused, and the script never runs.
    const root = make({
      'a.txt': 'x\n',
      'evil.awk': 'BEGIN { system("touch pwned") }\n',
    })

    const refused = await run(awkTool, { program: '-f evil.awk', path: 'a.txt' })

    expect(refused).toContain('only reads')
    expect(await Bun.file(join(root, 'pwned')).exists()).toBe(false)
  })

  test('refuses getline even with a variable between it and the file', async () => {
    // The old check looked for `<` right after `getline`, so `getline line < f`
    // — a variable in between — slipped through and awk read a file outside the
    // workspace. Every getline is refused now, whatever shape it takes.
    const outside = join(make({ 'a.txt': 'x\n' }), '..', 'aidcrew-awk-outside.txt')
    writeFileSync(outside, 'OUTSIDE SECRET LINE\n')

    try {
      const refused = await run(awkTool, {
        program: `BEGIN { f = "${outside}"; while ((getline line < f) > 0) print line }`,
        path: 'a.txt',
      })

      expect(refused).toContain('only reads')
      expect(refused).not.toContain('OUTSIDE SECRET LINE')
    } finally {
      rmSync(outside, { force: true })
    }
  })

  test('passes -F and -v to awk as flags, spaced or attached', async () => {
    // The program used to be split on whitespace and rejoined, which turned
    // `-F ,` and `-v name=value` into gibberish. Flags are parsed off the front
    // now and the program is handed to awk in one piece.
    make({ 'sp.txt': 'alice 30\nbob 41\n', 'csv.txt': 'a,b,c\nd,e,f\n' })

    const withVar = await run(awkTool, { program: '-v tag=hi { print tag, $1 }', path: 'sp.txt' })
    expect(withVar.split('\n')).toEqual(['hi alice', 'hi bob'])

    const bySep = await run(awkTool, { program: '-F , { print $2 }', path: 'csv.txt' })
    expect(bySep.split('\n')).toEqual(['b', 'e'])
  })

  test('passes a multi-line program and one with a comment through untouched', async () => {
    // Whitespace-joining a multi-line program folded its lines together, and a
    // leading `#` comment then swallowed the whole program. Passed as one
    // argument, both run as written.
    make({ 'n.txt': '3\n9\n' })

    const multiline = await run(awkTool, { program: '{\n  x = $1\n  print x\n}', path: 'n.txt' })
    expect(multiline.split('\n')).toEqual(['3', '9'])

    const commented = await run(awkTool, { program: '# first field\n{ print $1 }', path: 'n.txt' })
    expect(commented.split('\n')).toEqual(['3', '9'])
  })
})

describe('lsof', () => {
  test('says which process holds a port', async () => {
    make({ 'a.txt': '' })
    const server = Bun.serve({ port: 0, fetch: () => new Response('ok') })

    try {
      const held = await run(lsofTool, { port: server.port })
      // Either the pid, or a plain statement that nothing holds it — never
      // an empty answer, which reads as the tool being broken.
      expect(held.length).toBeGreaterThan(0)
    } finally {
      server.stop(true)
    }
  })

  test('says so plainly when a port is free', async () => {
    make({ 'a.txt': '' })

    expect(await run(lsofTool, { port: 59_999 })).toContain('nothing')
  })
})
