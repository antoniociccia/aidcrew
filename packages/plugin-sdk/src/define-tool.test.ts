import { describe, expect, test } from 'bun:test'
import { z } from 'zod'
import { defineTool } from './define-tool.ts'

describe('a tool declared wrongly', () => {
  // The mistake costs a model turn and produces a message nobody can act on:
  // "A.run is not a function" out of a minified binary, after the model has
  // already paid to call the tool. Refused at declaration instead, where the
  // author is looking, and naming the field they got wrong.
  test('says which field is missing rather than failing at call time', () => {
    expect(() =>
      defineTool({
        name: 'hello',
        description: 'Says hello.',
        schema: z.object({}),
        // biome-ignore lint/suspicious/noExplicitAny: the point is a wrong shape
      } as any),
    ).toThrow(/hello.*run/)
  })

  test('an empty description is refused, because the model reads it', () => {
    expect(() =>
      defineTool({
        name: 'hello',
        description: '',
        schema: z.object({}),
        run: async () => ({ content: '' }),
      }),
    ).toThrow(/description/)
  })

  test('a nameless tool is refused', () => {
    expect(() =>
      defineTool({
        name: '',
        description: 'x',
        schema: z.object({}),
        run: async () => ({ content: '' }),
      }),
    ).toThrow(/name/)
  })

  test('a schema that is not a schema is refused by name', () => {
    expect(() =>
      defineTool({
        name: 'hello',
        description: 'Says hello.',
        // biome-ignore lint/suspicious/noExplicitAny: the point is a wrong shape
        schema: { type: 'object' } as any,
        run: async () => ({ content: '' }),
      }),
    ).toThrow(/hello.*schema/)
  })
})
