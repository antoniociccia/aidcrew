import type { Tool, ToolContext, ToolOutput } from '@aidcrew/core'
import { z } from 'zod'

export type ToolSpec<S extends z.ZodType> = {
  /**
   * Whether this tool changes nothing.
   *
   * Say so and the loop runs it alongside the other read-only calls in the
   * same turn, instead of waiting for each in turn. Leave it out and it is
   * simply as slow as it was, which is the answer that costs time rather than
   * correctness.
   */
  reads?: boolean

  name: string
  /**
   * Shown to the model, so it is charged to every request of the session.
   * Say what the tool does and the one thing that is easy to get wrong;
   * leave out everything else.
   */
  description: string
  schema: S
  run(input: z.infer<S>, context: ToolContext): Promise<ToolOutput>
}

/**
 * Builds a tool from a single Zod schema, which becomes both the JSON Schema
 * the model sees and the validation the arguments must pass. One declaration,
 * so the two can never drift apart.
 *
 * The resulting `execute` never throws: a thrown error becomes a failed tool
 * result, because a model that reads "no such file" can correct itself, while
 * an exception just ends the session.
 */
export function defineTool<S extends z.ZodType>(spec: ToolSpec<S>): Tool {
  refuseBadSpec(spec)

  return {
    name: spec.name,
    ...(spec.reads ? { reads: true } : {}),
    description: spec.description,
    inputSchema: z.toJSONSchema(spec.schema) as Record<string, unknown>,

    async execute(input: unknown, context: ToolContext): Promise<ToolOutput> {
      const parsed = spec.schema.safeParse(input)
      if (!parsed.success) {
        return {
          content: `invalid arguments for ${spec.name}: ${formatIssues(parsed.error)}`,
          isError: true,
        }
      }

      try {
        return await spec.run(parsed.data, context)
      } catch (cause) {
        return {
          content: cause instanceof Error ? cause.message : String(cause),
          isError: true,
        }
      }
    },
  }
}

/**
 * Refuses a declaration that would only fail later.
 *
 * A mistyped field — `execute` where the contract says `run` — used to survive
 * loading and then produce "A.run is not a function" out of a minified binary,
 * after the model had already paid a turn to call the tool. Here the author is
 * still looking at the file, and the message names the field.
 */
function refuseBadSpec(spec: ToolSpec<z.ZodType>): void {
  const name = typeof spec?.name === 'string' && spec.name !== '' ? spec.name : undefined
  if (!name) throw new Error('defineTool: a tool needs a "name" the model can call it by')

  if (typeof spec.description !== 'string' || spec.description.trim() === '') {
    throw new Error(
      `defineTool("${name}"): a "description" is required — it is the only thing the model reads ` +
        'before choosing this tool',
    )
  }
  if (typeof spec.run !== 'function') {
    throw new Error(
      `defineTool("${name}"): "run" must be a function (input, context) => Promise<ToolOutput>`,
    )
  }
  // Duck-typed rather than `instanceof z.ZodType`: a plugin that ended up with
  // its own copy of zod would fail that check while working perfectly.
  if (typeof (spec.schema as { safeParse?: unknown })?.safeParse !== 'function') {
    throw new Error(
      `defineTool("${name}"): "schema" must be a zod schema — it becomes both the JSON Schema the ` +
        'model sees and the validation the arguments must pass',
    )
  }
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => {
      const path = issue.path.join('.')
      return path ? `${path}: ${issue.message}` : issue.message
    })
    .join('; ')
}
