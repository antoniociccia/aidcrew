/** The items on one page of a list, pages counted from 1. */
export function paginate<T>(items: readonly T[], page: number, perPage: number): T[] {
  if (!Number.isInteger(page) || page < 1) {
    throw new RangeError(`page must be 1 or more, got ${page}`)
  }
  if (!Number.isInteger(perPage) || perPage < 1) {
    throw new RangeError(`perPage must be 1 or more, got ${perPage}`)
  }
  const start = (page - 1) * perPage
  return items.slice(start, start + perPage)
}

/** How many pages a list of this many items takes. */
export function pageCount(total: number, perPage: number): number {
  return Math.ceil(total / perPage)
}
