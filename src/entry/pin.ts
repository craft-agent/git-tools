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
import { gateRefusal, uncoveredRefusal } from "./gate"
import { permissionResources } from "./permission"

/** What a tool needs for its approval: its schema, its gate, its targets, its describer and what a grant over it checks (`id`, `class`, `bounds`, `measure`). */
type ApprovalSpec = Pick<ToolSpec, "id" | "class" | "input" | "gate" | "targets" | "describe" | "bounds" | "measure">

/** What an approval is drawn from, or the refusal of the tool's gate, which no approval may override. */
export type Approval =
  | { refused: ToolError; resources?: undefined; description?: undefined; pin?: undefined }
  | { refused?: undefined; resources: string[]; description?: ShownDescription; pin?: string }

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
 * description has no pin. When the tool's gate refuses the call, the answer
 * is `{ refused }` alone: nothing is resolved, and the caller must not ask.
 * So is the answer for a write that no live grant covers while no one can be
 * asked (`ctx.grants.unattended`): there is no one to ask.
 */
export async function approvalOf(
  spec: ApprovalSpec,
  args: unknown,
  ctx: ToolContext,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS,
  t: Translator = ENGLISH,
): Promise<Approval> {
  const refused = (await gateRefusal(spec, args, ctx)) ?? (await uncoveredRefusal(spec, args, ctx))
  if (refused) return { refused }
  const [resources, raw] = await resolveCall(spec, args, ctx, timeoutMs)
  if (raw === undefined) return { resources }
  return { resources, description: shownDescription(raw, t), pin: pinOf(resources, raw) }
}

/**
 * Right before a call runs: resolves the resources and the description again
 * and throws `stale` unless they still give `pin` (taken on the description
 * before the prompt cuts it), so the call runs on what its prompt showed and
 * on what it left out. A description that can no longer be told counts as a
 * change. Without a pin it returns at once and resolves nothing. A call the
 * tool's gate refuses throws that refusal first, pin or none, so nothing is
 * resolved for it. A cancellation is rethrown, never turned into `stale`.
 */
export async function checkPin(
  spec: ApprovalSpec,
  args: unknown,
  ctx: ToolContext,
  pin: string | undefined,
  timeoutMs: number = DESCRIBE_TIMEOUT_MS,
): Promise<void> {
  const refused = await gateRefusal(spec, args, ctx)
  if (refused) throw refused
  if (pin === undefined) return
  const [resources, raw] = await resolveCall(spec, args, ctx, timeoutMs)
  if (raw !== undefined && pinOf(resources, raw) === pin) return
  throw new ToolError(
    "stale",
    `${spec.id} did not run: what its approval showed changed before it could run. Call it again to be asked again.`,
  )
}
