import { chmodSync, mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { startWebUI } from '@aidcrew/web-ui'
import { render } from 'ink'
import { App } from './app.tsx'
import { leaveOnSignal } from './hangup.ts'
import { fixedKeyboard } from './keyboard.ts'
import { paintOver } from './paint-over.ts'
import { openRuntime } from './runtime.ts'
import { claimScreen } from './screen.ts'
import { webSession } from './web-session.ts'

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
  const connection = webSession()
  let web: ReturnType<typeof startWebUI> | undefined
  let accessFile: string | undefined
  if (options.env.AIDCREW_WEB !== '0') {
    try {
      const wanted = Number(options.env.AIDCREW_WEB_PORT ?? 4318)
      if (!Number.isInteger(wanted) || wanted < 0 || wanted > 65535)
        throw new Error('Invalid AIDCREW_WEB_PORT')
      try {
        web = startWebUI(connection, { port: wanted })
      } catch (error) {
        if (options.env.AIDCREW_WEB_PORT || (error as NodeJS.ErrnoException).code !== 'EADDRINUSE')
          throw error
        web = startWebUI(connection, { port: 0 })
      }
      const directory = join(home, '.aidcrew', 'web')
      mkdirSync(directory, { recursive: true, mode: 0o700 })
      chmodSync(directory, 0o700)
      accessFile = join(directory, `${process.pid}.json`)
      writeFileSync(
        accessFile,
        JSON.stringify({ pid: process.pid, address: web.address, url: web.url }, null, 2),
        { mode: 0o600, flag: 'wx' },
      )
      runtime.host.registry.register(web.plugin)
      process.stderr.write(`Web UI: ${web.address} · private access link: ${accessFile}\n`)
      if (options.env.AIDCREW_WEB_OPEN !== '0') {
        const command =
          process.platform === 'darwin'
            ? ['open', web.url]
            : process.platform === 'win32'
              ? ['rundll32.exe', 'url.dll,FileProtocolHandler', web.url]
              : ['xdg-open', web.url]
        try {
          Bun.spawn(command, { stdout: 'ignore', stderr: 'ignore' }).unref()
        } catch {
          /* The private access file remains available on hosts without a desktop. */
        }
      }
    } catch (error) {
      web?.close()
      web = undefined
      process.stderr.write(
        `Web UI could not start: ${error instanceof Error ? error.message : String(error)}\n`,
      )
    }
  }
  const screen = claimScreen()

  const app = render(
    <App
      runtime={runtime}
      home={home}
      env={options.env}
      web={connection}
      {...(accessFile ? { webAccessFile: accessFile } : {})}
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
    web?.close()
    if (accessFile) {
      try {
        unlinkSync(accessFile)
      } catch {}
    }
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
