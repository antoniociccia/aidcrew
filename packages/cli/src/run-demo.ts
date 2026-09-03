import { chmodSync } from 'node:fs'
import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Plugin, Provider, StreamDelta } from '@aidcrew/core'
import { definePlugin } from '@aidcrew/plugin-sdk'

/**
 * Sixty seconds to a working agent, with no key and no account.
 *
 * The no-key path has existed since the beginning and needed a clone, Bun, two
 * terminals and four environment variables — which is a fine way to show a
 * contributor how the pieces fit and no way at all to show somebody who has
 * just downloaded a binary. This is the same thing in one word.
 *
 * Everything here is real except the model: real files on disk, the real
 * tools, the real loop, the real guards. What is fake is the one thing that
 * would otherwise need a credit card, and it is fake in the way the rest of
 * this project says things should be — as a plugin, loaded through the same
 * registry a stranger's would be.
 */

/** The bug, the check that catches it, and something to read. */
export async function plantDemoProject(): Promise<string> {
  const repo = await mkdtemp(join(tmpdir(), 'aidcrew-demo-'))

  // `add` subtracts, and the check says so. A task rather than a puzzle: the
  // agent can tell whether it is done, which is what makes the demo honest.
  await writeFile(join(repo, 'math.js'), 'export const add = (a, b) => a - b\n')
  // Pure bash, deliberately: aidcrew ships as one self-contained binary, and
  // this demo is the path for somebody who has installed nothing else. A
  // check that shells out to `node` — or to `bun`, not guaranteed on a
  // binary user's PATH either — reports "still broken" on a clean machine
  // regardless of whether the agent fixed anything, which is the one thing
  // a demo about trusting the check must never do. Grep on the real file is
  // still a real check: the operator on disk is what decides the exit code.
  await writeFile(join(repo, 'check.sh'), "#!/bin/bash\ngrep -q 'a + b' math.js\n")
  chmodSync(join(repo, 'check.sh'), 0o755)
  await writeFile(
    join(repo, 'README.md'),
    '# math\n\n`./check.sh` exits 0 when `add` is right and 1 when it is not.\n',
  )

  return repo
}

type Step = { tool: string; input: unknown } | { text: string }

/**
 * What the fake model does, in order.
 *
 * Scripted rather than clever: the point is to show the loop — a call, a
 * result handed back, another call — against files that really change on
 * disk. A model that improvised would sometimes not, and a demo that works
 * four times in five is a demo that does not work.
 */
const SCRIPT: Step[] = [
  { tool: 'bash', input: { command: './check.sh' } },
  { tool: 'read', input: { path: 'math.js' } },
  { tool: 'edit', input: { path: 'math.js', oldString: 'a - b', newString: 'a + b' } },
  { tool: 'bash', input: { command: './check.sh' } },
  { text: 'add was subtracting instead of adding. The check passes now.' },
]

const USAGE = { inputTokens: 0, outputTokens: 0 }

/** The scripted model, as a provider a plugin can declare. */
export function demoProvider(): Provider {
  let at = 0
  return {
    id: 'demo',
    async *send(): AsyncIterable<StreamDelta> {
      const step = SCRIPT[at]
      at += 1

      if (!step) {
        yield { type: 'text_delta', text: 'nothing left to do.' }
        yield { type: 'done', stopReason: 'end_turn', usage: USAGE }
        return
      }

      if ('text' in step) {
        yield { type: 'text_delta', text: step.text }
        yield { type: 'done', stopReason: 'end_turn', usage: USAGE }
        return
      }

      const id = `demo-${at}`
      yield { type: 'tool_use_start', id, name: step.tool }
      yield { type: 'tool_use_delta', id, partialInput: JSON.stringify(step.input) }
      yield { type: 'tool_use_end', id }
      yield { type: 'done', stopReason: 'tool_use', usage: USAGE }
    },
  }
}

/**
 * The fake model as a plugin, because that is what this project says.
 *
 * It would have been shorter to reach into the loop and hand it a provider.
 * Going through the registry instead is the same claim the README makes,
 * demonstrated in the one place a newcomer is certain to run.
 */
export function demoPlugin(): Plugin {
  return definePlugin({
    name: 'demo-model',
    providers: [{ id: 'demo', create: () => demoProvider(), needsKey: false }],
  })
}

export function demoIntro(repo: string): string {
  return (
    'A throwaway project with a real bug, and a model that does not exist.\n' +
    'Real files, real tools, the real loop — nothing leaves this machine.\n\n' +
    `  ${repo}\n\n` +
    '  export const add = (a, b) => a - b     <- ./check.sh exits 1\n\n'
  )
}

export function demoOutro(repo: string, fixed: boolean): string {
  if (!fixed) {
    return (
      '\nThe demo did not end with a working check, which is a bug in aidcrew\n' +
      `rather than in the demo. The project is still at ${repo} if you want to look.\n`
    )
  }
  return (
    '\n  export const add = (a, b) => a + b     <- ./check.sh exits 0\n\n' +
    'That was the whole loop. With a key of your own it is the same thing\n' +
    'against your own code:\n\n' +
    '  aidcrew config set-key provider:zen\n' +
    '  aidcrew -p "make the failing test pass"\n' +
    '  aidcrew                                 the whole team, one screen\n\n' +
    `The demo project is at ${repo} and is yours to delete.\n`
  )
}
