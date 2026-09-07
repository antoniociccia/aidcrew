export type Todo = { id: number; text: string; done: boolean }

export function add(todos: Todo[], text: string): Todo[] {
  const id = todos.reduce((max, todo) => Math.max(max, todo.id), 0) + 1
  return [...todos, { id, text, done: false }]
}

export function render(todos: Todo[]): string {
  return todos.map((todo) => `${todo.id}. ${todo.text}`).join('\n')
}
