/** Shared local identity: never sends agent names to an avatar service. */
export interface AgentAvatar {
  readonly color: string
  readonly background: string
  readonly initials: string
  readonly mark: string
  readonly label: string
  readonly cells: readonly { readonly x: number; readonly y: number }[]
}

const COLORS = ['#b7f4cf', '#b6caff', '#efc1ff', '#ffd392', '#9de0ed', '#f7b4aa'] as const

function hashIdentity(id: string): number {
  let hash = 2166136261
  for (let index = 0; index < id.length; index++) {
    hash = Math.imul(hash ^ id.charCodeAt(index), 16777619)
  }
  return hash >>> 0
}

function initialsFor(value: string): string {
  const parts = value.toUpperCase().match(/[A-Z0-9]+/g) ?? []
  if (parts.length > 1) return `${parts[0]?.[0] ?? ''}${parts.at(-1)?.[0] ?? ''}`
  return parts[0]?.slice(0, 2) || '?'
}

function identityCells(hash: number): AgentAvatar['cells'] {
  const cells: { x: number; y: number }[] = []
  let random = hash || 1
  for (let y = 0; y < 5; y++) {
    for (let x = 0; x < 3; x++) {
      random ^= random << 13
      random ^= random >>> 17
      random ^= random << 5
      // The center spine guarantees a recognizable, nonempty silhouette.
      if (x !== 2 && (random >>> 0) % 2 === 0) continue
      cells.push({ x, y })
      if (x !== 2) cells.push({ x: 4 - x, y })
    }
  }
  return cells
}

/** Labels are plain text: render with textContent/aria-label, never innerHTML. */
export function agentAvatar(id: string, role?: string): AgentAvatar {
  const hash = hashIdentity(id)
  return {
    color: COLORS[hash % COLORS.length] ?? COLORS[0],
    background: '#18212d',
    initials: initialsFor(id),
    mark: initialsFor(role || id).slice(0, 1),
    label: role ? `${id || '?'} · ${role}` : id || '?',
    cells: identityCells(hash),
  }
}
