export type ProviderChoice = { value: string; label: string; hint?: string }

/**
 * What to put on the list of things an agent can run on.
 *
 * A provider is an endpoint with a key, and choosing it is the first of two
 * decisions — the model list comes next. The hint says so at the moment of
 * choosing, because a list that looks finished and then asks again reads as
 * broken.
 */
export function providerChoices(providers: string[]): ProviderChoice[] {
  return providers.map((id) => ({
    value: id,
    label: id,
    hint: 'an endpoint — you choose the model next',
  }))
}
