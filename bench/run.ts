/**
 * Runs the benchmark: every configuration on every task, graded by tests the
 * agents never see, with what it cost beside what it solved.
 *
 *   bun bench/run.ts [--configurations a,b] [--tasks x,y] [--budget 20]
 *                    [--parallel 3] [--timeout-minutes 20] [--out file.json]
 *
 * The credentials are aidcrew's own: the key saved in Settings, or the
 * provider's AIDCREW_API_KEY_* variable in the environment. Every run gets a
 * home of its own, holding nothing but a copy of the settings database, so
 * the crew and config a person keeps in their own home stay out of it.
 * Results are written after every run, so a run that is stopped keeps what
 * it has, and a results file passed with --out is picked up where it was
 * left.
 */
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { parseArgs } from 'node:util'
import {
  CONFIGURATIONS,
  type Configuration,
  configToml,
  costOf,
  nextRuns,
  parseVerdict,
  type RunRecord,
  table,
} from './lib.ts'

const ROOT = join(import.meta.dir, '..')
const BIN = join(ROOT, 'packages/cli/src/bin.ts')
const TASKS = join(import.meta.dir, 'tasks')
const AGENTS = join(import.meta.dir, 'agents')
/** Files bun would run as tests are kept under this suffix, so the repository's own suite does not. */
const FIXTURE = '.fixture'

export type Task = { name: string; category: string; instruction: string; dir: string }

/** Every task under `tasks/`, or the ones named. */
export function tasksNamed(names?: string[]): Task[] {
  return readdirSync(TASKS)
    .filter((name) => existsSync(join(TASKS, name, 'task.json')))
    .filter((name) => !names || names.includes(name))
    .map((name) => {
      const meta = JSON.parse(readFileSync(join(TASKS, name, 'task.json'), 'utf8')) as {
        category: string
        instruction: string
      }
      return {
        name,
        category: meta.category,
        instruction: meta.instruction,
        dir: join(TASKS, name),
      }
    })
}

/** Copies a tree, giving fixture files their real names. */
export function materialise(from: string, into: string): void {
  if (!existsSync(from)) return
  for (const entry of readdirSync(from, { withFileTypes: true, recursive: true })) {
    if (!entry.isFile()) continue
    const source = join(entry.parentPath, entry.name)
    const named = relative(from, source)
    const target = join(into, named.endsWith(FIXTURE) ? named.slice(0, -FIXTURE.length) : named)
    mkdirSync(join(target, '..'), { recursive: true })
    cpSync(source, target)
  }
}

async function git(args: string[], cwd: string): Promise<void> {
  const proc = Bun.spawn(['git', ...args], {
    cwd,
    stdout: 'ignore',
    stderr: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'bench',
      GIT_AUTHOR_EMAIL: 'bench@aidcrew.dev',
      GIT_COMMITTER_NAME: 'bench',
      GIT_COMMITTER_EMAIL: 'bench@aidcrew.dev',
    },
  })
  await proc.exited
}

/** A fresh repository holding the task, with the configuration's team declared in it. */
async function prepare(task: Task, config: Configuration): Promise<string> {
  const dir = realpathSync(
    mkdtempSync(join(tmpdir(), `aidcrew-bench-${task.name}-${config.name}-`)),
  )
  materialise(join(task.dir, 'project'), dir)
  mkdirSync(join(dir, '.aidcrew/agents'), { recursive: true })
  writeFileSync(join(dir, '.aidcrew/config.toml'), configToml(config))
  for (const agent of config.agents) {
    cpSync(join(AGENTS, `${agent.id}.md`), join(dir, '.aidcrew/agents', `${agent.id}.md`))
  }
  await git(['init', '-q', '-b', 'main'], dir)
  await git(['add', '.'], dir)
  await git(['commit', '-qm', 'the task as given'], dir)
  return dir
}

/** Whether the repository, hidden tests added, passes: the only success that counts. */
export async function grade(task: Task, dir: string): Promise<boolean> {
  // The checkouts under .aidcrew would be scanned too, and they hold copies.
  rmSync(join(dir, '.aidcrew'), { recursive: true, force: true })
  materialise(join(task.dir, 'hidden'), dir)
  const proc = Bun.spawn(['bun', 'test'], {
    cwd: dir,
    stdout: 'ignore',
    stderr: 'ignore',
    timeout: 120_000,
  })
  return (await proc.exited) === 0
}

/**
 * A home for the run, holding a copy of the settings database and nothing
 * else: the saved keys come along, the person's own crew and config do not.
 */
function cleanHome(): string {
  const home = mkdtempSync(join(tmpdir(), 'aidcrew-bench-home-'))
  mkdirSync(join(home, '.aidcrew'), { recursive: true })
  for (const name of ['aidcrew.db', 'aidcrew.db-wal', 'aidcrew.db-shm']) {
    const source = join(homedir(), '.aidcrew', name)
    if (existsSync(source)) cpSync(source, join(home, '.aidcrew', name))
  }
  return home
}

async function runOne(
  task: Task,
  config: Configuration,
  timeoutMs: number,
  logs: string,
  run: number,
): Promise<RunRecord> {
  const dir = await prepare(task, config)
  const home = cleanHome()
  const started = Date.now()
  const proc = Bun.spawn(['bun', BIN, 'team', '-p', task.instruction, '-C', dir, '--json'], {
    cwd: dir,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: timeoutMs,
    env: { ...process.env, AIDCREW_HOME: home },
  })
  const [out, err, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  const seconds = (Date.now() - started) / 1000
  // Everything the run printed, kept: a failure nobody can read is a failure
  // nobody can fix, and the log is what a task's write-up is made from.
  mkdirSync(logs, { recursive: true })
  writeFileSync(
    join(logs, `${task.name}--${config.name}${run > 1 ? `--${run}` : ''}.log`),
    `${out}\n--- stderr ---\n${err}`,
  )
  const verdict = parseVerdict(out)
  const passed = await grade(task, dir)
  rmSync(dir, { recursive: true, force: true })
  rmSync(home, { recursive: true, force: true })
  const base = {
    task: task.name,
    category: task.category,
    configuration: config.name,
    run,
    seconds,
    passed,
  }

  if (!verdict) {
    return {
      ...base,
      done: false,
      usd: 0,
      costSource: 'unknown',
      inputTokens: 0,
      outputTokens: 0,
      turns: 0,
      exitCode: code,
      error: proc.signalCode
        ? `timed out after ${Math.round(timeoutMs / 60_000)} minutes`
        : `${err}${out}`.trim().slice(-600),
    }
  }

  const cost = costOf(verdict.agents)
  const job = verdict.jobs[0]
  return {
    ...base,
    done: verdict.jobs.length > 0 && verdict.jobs.every((one) => one.done),
    usd: cost.usd,
    costSource: cost.source,
    inputTokens: verdict.agents.reduce((sum, agent) => sum + agent.usage.inputTokens, 0),
    outputTokens: verdict.agents.reduce((sum, agent) => sum + agent.usage.outputTokens, 0),
    turns: verdict.agents.reduce((sum, agent) => sum + agent.turns, 0),
    exitCode: verdict.exitCode,
    ...(job?.left ? { left: job.left } : {}),
    ...(job?.warnings ? { warnings: job.warnings } : {}),
  }
}

async function main(): Promise<number> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      configurations: { type: 'string' },
      tasks: { type: 'string' },
      budget: { type: 'string', default: '20' },
      parallel: { type: 'string', default: '3' },
      'timeout-minutes': { type: 'string', default: '20' },
      out: { type: 'string' },
      repeat: { type: 'string', default: '1' },
    },
  })
  const configs = CONFIGURATIONS.filter(
    (one) => !values.configurations || values.configurations.split(',').includes(one.name),
  )
  const tasks = tasksNamed(values.tasks?.split(','))
  const budget = Number(values.budget)
  const parallel = Math.max(1, Number(values.parallel))
  const timeoutMs = Number(values['timeout-minutes']) * 60_000
  const out =
    values.out ?? join(import.meta.dir, 'results', `${new Date().toISOString().slice(0, 10)}.json`)

  const records: RunRecord[] = existsSync(out)
    ? (JSON.parse(readFileSync(out, 'utf8')) as RunRecord[])
    : []
  const repeat = Math.max(1, Number(values.repeat))
  const queue = nextRuns(
    tasks.map((task) => task.name),
    configs.map((config) => config.name),
    records,
    repeat,
  )
  console.log(
    `${queue.length} runs to go, ${records.length} already in ${relative(ROOT, out)}, budget $${budget}`,
  )

  let spent = records.reduce((sum, record) => sum + record.usd, 0)
  let stopped = false
  const save = () => {
    mkdirSync(join(out, '..'), { recursive: true })
    writeFileSync(out, `${JSON.stringify(records, null, 2)}\n`)
    writeFileSync(out.replace(/\.json$/, '.md'), table(records))
  }

  const worker = async () => {
    for (;;) {
      const next = queue.shift()
      if (!next || stopped) return
      if (spent > budget) {
        stopped = true
        console.log(`budget of $${budget} reached at $${spent.toFixed(2)}: stopping`)
        return
      }
      const task = tasks.find((one) => one.name === next.task)
      const config = configs.find((one) => one.name === next.configuration)
      if (!task || !config) continue
      console.log(`-> ${task.name} on ${config.name}${repeat > 1 ? ` (run ${next.run})` : ''}`)
      const record = await runOne(
        task,
        config,
        timeoutMs,
        out.replace(/\.json$/, '-logs'),
        next.run,
      )
      records.push(record)
      spent += record.usd
      save()
      const mark = record.error
        ? `error: ${record.error.split('\n')[0]}`
        : record.passed
          ? 'passed'
          : record.done
            ? 'said done, failed'
            : 'not done'
      console.log(
        `   ${task.name} on ${config.name}: ${mark}, $${record.usd.toFixed(3)}, ${Math.round(record.seconds)}s`,
      )
    }
  }
  await Promise.all(Array.from({ length: parallel }, worker))
  save()
  console.log(`\n${table(records)}`)
  console.log(`spent $${spent.toFixed(2)} in total; results in ${relative(ROOT, out)}`)
  return 0
}

if (import.meta.main) process.exit(await main())
