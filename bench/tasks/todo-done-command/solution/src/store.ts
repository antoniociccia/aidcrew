export type Todo = { id: number; text: string; done: boolean }

export function add(todos: Todo[], text: string): Todo[] {
  const id = todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1
  return [...todos, { id, text, done: false }]
}

/** A new list with the todo of that id done; the list given is untouched. */
export function markDone(todos: Todo[], id: number): Todo[] {
  if (!todos.some((todo) => todo.id === id)) throw new RangeError(`no todo with id ${id}`)
  return todos.map((todo) => (todo.id === id ? { ...todo, done: true } : todo))
}

export function render(todos: Todo[]): string {
  return todos.map((todo) => `${todo.id}. [${todo.done ? 'x' : ' '}] ${todo.text}`).join('\n')
}
