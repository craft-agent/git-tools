import { ANY_TARGET, writeTargets, type ToolContext, type ToolSpec } from "../core"

/** What a permission rule matches when what a call writes to cannot be told. */
export const ANY_RESOURCE = ANY_TARGET

/**
 * The resources a permission rule matches: everything the call writes to
 * (see `writeTargets`), with `*` for what cannot be told; the call then fails
 * its own way.
 */
export function permissionResources(
  spec: Pick<ToolSpec, "input" | "targets">,
  args: unknown,
  ctx: ToolContext,
): Promise<string[]> {
  return writeTargets(spec, args, ctx)
}
