/** The items on one page of a list, pages counted from 1. */
export function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  const start = page * perPage
  return items.slice(start, start + perPage)
}

/** How many pages a list of this many items takes. */
export function pageCount(total: number, perPage: number): number {
  return Math.ceil(total / perPage)
}
