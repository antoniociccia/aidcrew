export type NativeClaudeOptions = {
  args: string[]
  cwd: string
  env: Record<string, string | undefined>
  spawn?: (
    argv: string[],
    options: {
      cwd: string
      env: Record<string, string | undefined>
      stdin: 'inherit'
      stdout: 'inherit'
      stderr: 'inherit'
    },
  ) => { exited: Promise<number> }
}

export class NativeClaudeError extends Error {
  override readonly name = 'NativeClaudeError'
}

/** Claude owns authentication, permissions and every argument after the subcommand. */
export async function runNativeClaude(options: NativeClaudeOptions): Promise<number> {
  const spawn = options.spawn ?? ((argv, settings) => Bun.spawn(argv, settings))
  try {
    const child = spawn(['claude', ...options.args], {
      cwd: options.cwd,
      env: options.env,
      stdin: 'inherit',
      stdout: 'inherit',
      stderr: 'inherit',
    })
    return await child.exited
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      throw new NativeClaudeError(
        'Claude Code is not installed on PATH, or the working directory is unavailable.',
      )
    }
    throw new NativeClaudeError(
      'Claude Code could not start or its process could not be monitored.',
    )
  }
}
