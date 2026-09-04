import { homedir } from 'node:os'
import { render } from 'ink'
import { App } from './app.tsx'
import { leaveOnSignal } from './hangup.ts'
import { fixedKeyboard } from './keyboard.ts'
import { paintOver } from './paint-over.ts'
import { openRuntime } from './runtime.ts'
import { claimScreen } from './screen.ts'

/**
 * Opens the interface.
 *
 * Separate from the CLI's entry point so that the command-line paths stay
 * usable without React ever being loaded — a headless run in CI should not
 * pay for a terminal interface it will never draw.
 */
export async function startInterface(options: {
  cwd?: string | undefined
  home?: string | undefined
  env: Record<string, string | undefined>
}): Promise<number> {
  // Ink needs raw mode, which a pipe cannot give it. Saying so plainly beats
  // a React stack trace that explains nothing about what to do instead.
  if (!process.stdin.isTTY) {
    process.stderr.write(
      'the interface needs a terminal.\n' +
        'Run "aidcrew" directly rather than through a pipe, or use\n' +
        '  aidcrew -p "<task>"        for a single agent\n' +
        '  aidcrew team -p "<task>"   for the whole team\n',
    )
    return 2
  }

  const home = options.home ?? homedir()
  const runtime = await openRuntime(options.cwd ?? process.cwd(), home)

  // The second screen every terminal has, the one vim and less use. Ink draws
  // into the scrollback otherwise: the interface becomes part of the shell's
  // history, it grows downwards as lines arrive, and the shell is left with a
  // wall of half-drawn frames behind it when the session ends. Claimed before
  // the first frame, given back however the process ends — a terminal left on
  // the alternate screen looks broken to its owner.
  const screen = claimScreen()

  const app = render(
    <App
      runtime={runtime}
      home={home}
      env={options.env}
      {...(options.cwd ? { initialCwd: options.cwd } : {})}
    />,
    // Keys some terminals will not send, put back before Ink reads them —
    // see keyboard.ts. It has to happen here, on the way in: by the time a
    // component is handed a keystroke, option-ò and a plain ò are the same.
    // ^c is the screen's to handle: it empties a half-typed line and quits
    // only on an empty one, and quitting goes through the team's shutdown so
    // the checkouts, the watcher and the record are closed properly. Left to
    // Ink, ^c ended the process before any of that ran.
    // Frames go out drawn over the last one rather than after wiping it, for
    // the terminals that paint a wipe before the frame arrives — see
    // paint-over.ts.
    { stdin: fixedKeyboard(process.stdin), stdout: paintOver(process.stdout), exitOnCtrlC: false },
  )

  // Signals skip the finally block, and ^C is how an interface is normally
  // closed — so the store is closed from both places, and closing twice is
  // harmless.
  const close = () => {
    runtime.close()
    screen.release()
  }
  const stopLeaving = leaveOnSignal(process, close)

  try {
    await app.waitUntilExit()
    return 0
  } finally {
    close()
    stopLeaving()
  }
}
