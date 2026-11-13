import { ToolError, isAbortError, isToolError, type ToolContext, type ToolSpec } from "../core"

/**
 * The refusal of a tool's `gate` for a call, or `undefined` when the call may
 * go on: the tool has no gate, the arguments fail the input schema (the call
 * then fails its own way in `invoke`), or the gate returns. A `ToolError` the
 * gate throws is the refusal. Any other failure of the gate is
 * `internal_error`, so a call that cannot be checked does not run. A
 * cancellation is rethrown.
 */
export async function gateRefusal(
  spec: Pick<ToolSpec, "input" | "gate">,
  args: unknown,
  ctx: ToolContext,
): Promise<ToolError | undefined> {
  if (!spec.gate) return undefined
  const parsed = spec.input.strict().safeParse(args)
  if (!parsed.success) return undefined

  try {
    await spec.gate(parsed.data, ctx)
    return undefined
  } catch (error) {
    if (isAbortError(error) || ctx.signal?.aborted) throw error
    if (isToolError(error)) return error
    return new ToolError("internal_error", "Could not tell whether this call is allowed, so it did not run.", {
      cause: error,
    })
  }
}
