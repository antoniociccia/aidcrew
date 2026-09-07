import { add, render, type Todo } from './store.ts'

export type Result = { out: string; todos: Todo[]; code: number }

/** One command against the todos: what it printed, the todos after it, and how it exited. */
export function run(args: string[], todos: Todo[]): Result {
  const [command, ...rest] = args
  if (command === 'add') {
    const next = add(todos, rest.join(' '))
    return { out: `added: ${rest.join(' ')}\n`, todos: next, code: 0 }
  }
  if (command === 'list') return { out: `${render(todos)}\n`, todos, code: 0 }
  return { out: 'usage: todo add <text> | list\n', todos, code: 2 }
}
