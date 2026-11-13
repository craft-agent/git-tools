import { ToolError, grantCheck, isAbortError, isToolError, type ToolContext, type ToolSpec } from "../core"

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

/**
 * The refusal of the grant check for a call while no one can be asked, or
 * `undefined` when the call may go on to a question: grants are off, the tool
 * reads or is exempt, a live grant covers the call, or the arguments fail the
 * input schema (the call then fails its own way in `invoke`). Nothing is
 * recorded. A `ToolError` the check throws is the refusal; any other failure
 * is `internal_error`, so a call that cannot be checked does not run. A
 * cancellation is rethrown.
 */
export async function uncoveredRefusal(
  spec: Parameters<typeof grantCheck>[0],
  args: unknown,
  ctx: ToolContext,
): Promise<ToolError | undefined> {
  if (!ctx.grants?.unattended) return undefined
  const parsed = spec.input.strict().safeParse(args)
  if (!parsed.success) return undefined

  try {
    await grantCheck(spec, parsed.data, ctx, "check")
    return undefined
  } catch (error) {
    if (isAbortError(error) || ctx.signal?.aborted) throw error
    if (isToolError(error)) return error
    return new ToolError("internal_error", "Could not tell whether a grant covers this call, so it did not run.", {
      cause: error,
    })
  }
}
