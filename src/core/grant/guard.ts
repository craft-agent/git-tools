import { isAbortError } from "../errors"
import { writeTargets } from "../targets"
import type { CallMeasure, ToolContext, ToolSpec } from "../tool"
import { grantRefusal, measureOf } from "./match"
import { authorizeCall, checkCall, finishCall, type GrantUse, type UsageOptions } from "./usage"

/** Where grants are kept and whether a person can be asked. */
export type GrantContext = {
  /** No person can be asked: a write runs only under a live grant that covers it. */
  unattended: boolean
  dir: string
  key: Buffer | undefined
  /** The clock; defaults to the system's. For tests. */
  now?: () => Date
}

const EXEMPT = new WeakSet<object>()

/** Marks a spec that runs while unattended without a grant (revoking a grant only narrows what runs). */
export function exemptFromGrants<T extends object>(spec: T): T {
  EXEMPT.add(spec)
  return spec
}

/** Whether `exemptFromGrants` marked the spec. */
export function isExemptFromGrants(spec: object): boolean {
  return EXEMPT.has(spec)
}

const PERSON_ONLY = new WeakSet<object>()

/** Marks a spec that only a person's answer to its own prompt may run: no standing answer, grant or unattended run covers it. */
export function askPersonOnly<T extends object>(spec: T): T {
  PERSON_ONLY.add(spec)
  return spec
}

/** Whether `askPersonOnly` marked the spec. */
export function isPersonOnly(spec: object): boolean {
  return PERSON_ONLY.has(spec)
}

function usageOptions(grants: GrantContext): UsageOptions {
  return { dir: grants.dir, key: grants.key, now: grants.now ?? (() => new Date()) }
}

/** The tool's own measure of the call, or `undefined` when it fails or is not the shape the bounds declare; a cancellation is rethrown. */
async function measureCall(
  spec: Pick<ToolSpec, "bounds" | "measure">,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<CallMeasure | undefined> {
  try {
    return measureOf(spec.bounds ?? {}, (await spec.measure?.(args, ctx)) ?? {})
  } catch (error) {
    if (isAbortError(error) || ctx.signal?.aborted) throw error
    return undefined
  }
}

/**
 * Decides whether a call may run while no one can be asked. Returns `undefined`
 * when nothing needs deciding: grants are off, the tool reads, or it is exempt.
 * Otherwise the call must be covered by a live grant, or this throws the
 * `forbidden` refusal (`person_only` first, before any file is read). In
 * `record` mode the covering grant's use is logged, in the same locked step as
 * the rate it counts against, and its `seq` is what `finishGrantUse` closes;
 * in `check` mode nothing is written and `seq` is 0.
 */
export async function grantCheck(
  spec: Pick<ToolSpec, "id" | "class" | "input" | "targets" | "bounds" | "measure">,
  args: Record<string, unknown>,
  ctx: ToolContext,
  mode: "check" | "record",
): Promise<GrantUse | undefined> {
  const grants = ctx.grants
  if (!grants?.unattended || spec.class === "read") return undefined
  if (isPersonOnly(spec)) throw grantRefusal("person_only", spec.id)
  if (isExemptFromGrants(spec)) return undefined

  const call = {
    spec: { id: spec.id, bounds: spec.bounds },
    targets: await writeTargets(spec, args, ctx),
    measure: await measureCall(spec, args, ctx),
    args,
  }
  const options = usageOptions(grants)
  if (mode === "record") return authorizeCall(options, call)
  return { grant: await checkCall(options, call), seq: 0 }
}

/**
 * Ends a call `grantCheck` recorded, with `ok` or the code of the error it
 * ended in. A failure to write is swallowed, so the log never hides the call's
 * own result or error.
 */
export async function finishGrantUse(use: GrantUse, ctx: ToolContext, outcome: string): Promise<void> {
  const grants = ctx.grants
  if (!grants) return
  try {
    await finishCall(usageOptions(grants), use.seq, outcome)
  } catch {
    // The call has already run; its own result is what the caller needs.
  }
}
