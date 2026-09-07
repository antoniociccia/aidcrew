import { add, markDone, render, type Todo } from './store.ts'

export type Result = { out: string; todos: Todo[]; code: number }

/** One command against the todos: what it printed, the todos after it, and how it exited. */
export function run(args: string[], todos: Todo[]): Result {
  const [command, ...rest] = args
  if (command === 'add') {
    const next = add(todos, rest.join(' '))
    return { out: `added: ${rest.join(' ')}\n`, todos: next, code: 0 }
  }
  if (command === 'list') return { out: `${render(todos)}\n`, todos, code: 0 }
  if (command === 'done') {
    const raw = rest[0] ?? ''
    const id = /^\d+$/.test(raw) ? Number(raw) : Number.NaN
    if (!Number.isInteger(id)) return { out: `error: not a todo id: ${raw}\n`, todos, code: 1 }
    try {
      const next = markDone(todos, id)
      const text = next.find((todo) => todo.id === id)?.text ?? ''
      return { out: `done: ${text}\n`, todos: next, code: 0 }
    } catch (error) {
      return {
        out: `error: ${error instanceof Error ? error.message : String(error)}\n`,
        todos,
        code: 1,
      }
    }
  }
  return { out: 'usage: todo add <text> | list | done <id>\n', todos, code: 2 }
}
