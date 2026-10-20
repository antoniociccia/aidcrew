/// <reference lib="dom" />
import { paletteText } from './palette-text.ts'

export type PaletteAction = {
  readonly id: string
  readonly label: string
  readonly description?: string
  readonly keywords?: readonly string[]
  readonly run: () => void
}

export function createPaletteModel(getActions: () => readonly PaletteAction[]) {
  let matches: readonly PaletteAction[] = []
  let selected = -1
  return {
    get selected() {
      return selected
    },
    search(query: string) {
      const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean)
      matches = getActions().filter((action) => {
        const text = [action.label, action.description ?? '', ...(action.keywords ?? [])]
          .join(' ')
          .toLowerCase()
        return terms.every((term) => text.includes(term))
      })
      selected = matches.length ? 0 : -1
      return matches
    },
    move(delta: number) {
      selected = matches.length ? (selected + delta + matches.length) % matches.length : -1
      return selected
    },
    current() {
      return matches[selected]
    },
    resolve(id: string) {
      return getActions().find((action) => action.id === id)
    },
  }
}

let paletteSequence = 0

/** Actions are supplied by the host so this UI cannot issue server commands on its own. */
export function initPalette(options: {
  readonly getActions: () => readonly PaletteAction[]
  readonly trigger?: HTMLElement
  readonly document?: Document
}) {
  const doc = options.document ?? document
  const model = createPaletteModel(options.getActions)
  const prefix = `command-palette-${++paletteSequence}`
  const dialog = doc.createElement('dialog')
  dialog.className = 'command-palette'
  dialog.setAttribute('aria-label', paletteText.title)
  const header = doc.createElement('div')
  header.className = 'command-palette-header'
  const input = doc.createElement('input')
  input.type = 'search'
  input.placeholder = paletteText.placeholder
  input.setAttribute('aria-label', paletteText.title)
  input.setAttribute('role', 'combobox')
  input.setAttribute('aria-autocomplete', 'list')
  input.setAttribute('aria-expanded', 'false')
  input.setAttribute('aria-controls', `${prefix}-list`)
  input.autocomplete = 'off'
  const dismiss = doc.createElement('button')
  dismiss.type = 'button'
  dismiss.textContent = '×'
  dismiss.setAttribute('aria-label', paletteText.close)
  header.append(input, dismiss)
  const list = doc.createElement('div')
  list.id = `${prefix}-list`
  list.className = 'command-palette-list'
  list.setAttribute('role', 'listbox')
  list.setAttribute('aria-label', paletteText.title)
  const empty = doc.createElement('p')
  empty.className = 'command-palette-empty'
  empty.textContent = paletteText.empty
  const status = doc.createElement('p')
  status.className = 'command-palette-status'
  status.setAttribute('role', 'status')
  const hint = doc.createElement('p')
  hint.className = 'command-palette-hint'
  hint.textContent = paletteText.hint
  dialog.append(header, list, empty, status, hint)
  doc.body.append(dialog)
  let previousFocus: Element | null = null
  let rows: HTMLElement[] = []

  function close() {
    if (!dialog.open) return
    dialog.close()
  }

  function restoreFocus() {
    input.setAttribute('aria-expanded', 'false')
    input.removeAttribute('aria-activedescendant')
    if (previousFocus?.isConnected && 'focus' in previousFocus) {
      ;(previousFocus as HTMLElement).focus()
    }
  }

  function selectRow() {
    for (const [index, row] of rows.entries()) {
      row.setAttribute('aria-selected', String(index === model.selected))
    }
    const row = rows[model.selected]
    if (row) {
      input.setAttribute('aria-activedescendant', row.id)
      row.scrollIntoView({ block: 'nearest' })
    } else input.removeAttribute('aria-activedescendant')
  }

  function execute(action: PaletteAction) {
    const current = model.resolve(action.id)
    if (!current) {
      render()
      return
    }
    // Restore focus before running a navigation action, which may set its own focus target.
    close()
    restoreFocus()
    previousFocus = null
    current.run()
  }

  function render() {
    const matches = model.search(input.value)
    list.replaceChildren()
    rows = matches.map((action, index) => {
      const row = doc.createElement('div')
      row.className = 'command-palette-option'
      row.id = `${prefix}-option-${index}`
      row.setAttribute('role', 'option')
      const label = doc.createElement('span')
      label.textContent = action.label
      row.append(label)
      if (action.description) {
        const description = doc.createElement('small')
        description.textContent = action.description
        row.append(description)
      }
      row.addEventListener('click', () => execute(action))
      list.append(row)
      return row
    })
    empty.hidden = matches.length > 0
    status.textContent = paletteText.results(matches.length)
    selectRow()
  }

  function open() {
    if (dialog.open || doc.querySelector('dialog[open]')) return
    previousFocus = doc.activeElement
    input.value = ''
    dialog.showModal()
    input.setAttribute('aria-expanded', 'true')
    render()
    input.focus()
  }

  function onGlobalKey(event: KeyboardEvent) {
    if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'k') {
      event.preventDefault()
      if (dialog.open) close()
      else open()
    }
  }

  input.addEventListener('input', render)
  input.addEventListener('keydown', (event) => {
    if (event.isComposing) return
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) {
      event.preventDefault()
      model.move(event.key === 'ArrowDown' ? 1 : -1)
      selectRow()
      return
    }
    if (event.key === 'Enter') {
      event.preventDefault()
      if ([event.ctrlKey, event.metaKey, event.altKey, event.shiftKey].some(Boolean)) return
      const action = model.current()
      if (action) execute(action)
    }
  })
  dialog.addEventListener('keydown', (event) => {
    // Search inputs consume Escape to clear their value before the dialog can cancel.
    if (event.key === 'Escape' && !event.isComposing) {
      event.preventDefault()
      close()
    }
    onGlobalKey(event)
    event.stopPropagation()
  })
  dialog.addEventListener('close', restoreFocus)
  dialog.addEventListener('click', (event) => {
    if (event.target !== dialog) return
    const bounds = dialog.getBoundingClientRect()
    if (
      event.clientX < bounds.left ||
      event.clientX > bounds.right ||
      event.clientY < bounds.top ||
      event.clientY > bounds.bottom
    )
      close()
  })
  dismiss.addEventListener('click', close)
  options.trigger?.addEventListener('click', open)
  doc.addEventListener('keydown', onGlobalKey)
  return {
    open,
    close,
    destroy() {
      close()
      restoreFocus()
      doc.removeEventListener('keydown', onGlobalKey)
      options.trigger?.removeEventListener('click', open)
      dialog.remove()
    },
  }
}
