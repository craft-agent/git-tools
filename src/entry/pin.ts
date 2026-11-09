import {
  ENGLISH,
  ToolError,
  pinOf,
  type CallDescription,
  type ToolContext,
  type ToolSpec,
  type Translator,
} from "../core"
import { DESCRIBE_TIMEOUT_MS, shownDescription, timedCallDescription, type ShownDescription } from "./description"
import { permissionResources } from "./permission"

/** What a tool needs for its approval: its schema, its targets and its describer. */
type ApprovalSpec = Pick<ToolSpec, "input" | "targets" | "describe">

/** The resources of a call and its description as the tool gave it, resolved together. */
function resolveCall(
  spec: ApprovalSpec,
  args: unknown,
  ctx: ToolContext,
  timeoutMs: number,
): Promise<[string[], CallDescription | undefined]> {
  return Promise.all([permissionResources(spec, args, ctx), timedCallDescription(spec, args, ctx, timeoutMs)])
}

/**
 * What an approval is drawn from: the resources of the call and, when the
 * tool describes it, the description as the prompt shows it (see
 * `permissionDescription`) and the `pin` of what was resolved, taken on the
 * description before the prompt cuts it. A call whose prompt shows no
 * description has no pin.
 */
export async function approvalOf(
  spec: ApprovalSpec,
  args: unknown,
  ctx: ToolContext,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS,
  t: Translator = ENGLISH,
): Promise<{ resources: string[]; description?: ShownDescription; pin?: string }> {
  const [resources, raw] = await resolveCall(spec, args, ctx, timeoutMs)
  if (raw === undefined) return { resources }
  return { resources, description: shownDescription(raw, t), pin: pinOf(resources, raw) }
}

/**
 * Right before a call runs: resolves the resources and the description again
 * and throws `stale` unless they still give `pin` (taken on the description
 * before the prompt cuts it), so the call runs on what its prompt showed and
 * on what it left out. A description that can no longer be told counts as a
 * change. Without a pin it returns at once and resolves nothing. A
 * cancellation is rethrown, never turned into `stale`.
 */
export async function checkPin(
  spec: Pick<ToolSpec, "id"> & ApprovalSpec,
  args: unknown,
  ctx: ToolContext,
  pin: string | undefined,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS,
): Promise<void> {
  if (pin === undefined) return
  const [resources, raw] = await resolveCall(spec, args, ctx, timeoutMs)
  if (raw !== undefined && pinOf(resources, raw) === pin) return
  throw new ToolError(
    "stale",
    `${spec.id} did not run: what its approval showed changed before it could run. Call it again to be asked again.`,
  )
}
