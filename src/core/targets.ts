import { isAbortError } from "./errors"
import type { ToolContext, ToolSpec } from "./tool"

/** What a permission rule matches when what a call writes to cannot be told. */
export const ANY_TARGET = "*"

/** The wildcards of a harness's permission patterns; a target holding one would grant more than it names. */
export const PATTERN_CHARACTERS = /[*?]/

/** A target as given, or `*` when it is not a usable name: not text, blank, or holding a wildcard. */
function targetName(target: unknown): string {
  return typeof target === "string" && target.trim() !== "" && !PATTERN_CHARACTERS.test(target) ? target : ANY_TARGET
}

/**
 * What a call writes to, as the permission rules of an entry point name it:
 * the targets the tool's resolver gives for the arguments, deduplicated and
 * sorted with `*` last. A tool without a resolver, arguments the input schema
 * rejects, a resolver that fails, a blank or non-text entry, an entry holding
 * a wildcard (`*` or `?`, which an "always" answer would store as a pattern)
 * and an empty answer all give `*`, and the call then fails its own way. A
 * cancellation is never turned into `*`; it is rethrown.
 */
export async function writeTargets(
  spec: Pick<ToolSpec, "input" | "targets">,
  args: unknown,
  ctx: ToolContext,
): Promise<string[]> {
  if (!spec.targets) return [ANY_TARGET]
  const parsed = spec.input.strict().safeParse(args)
  if (!parsed.success) return [ANY_TARGET]

  let targets: unknown
  try {
    targets = await spec.targets(parsed.data, ctx)
  } catch (error) {
    if (isAbortError(error) || ctx.signal?.aborted) throw error
    return [ANY_TARGET]
  }
  if (!Array.isArray(targets)) return [ANY_TARGET]

  const names = new Set(targets.map(targetName))
  if (names.size === 0) return [ANY_TARGET]
  const specific = [...names].filter((name) => name !== ANY_TARGET).sort()
  return names.has(ANY_TARGET) ? [...specific, ANY_TARGET] : specific
}
