import { z } from "zod"
import { isToolError } from "../errors"
import { git } from "../git"
import {
  checkRewrite,
  isAncestor,
  remoteBranchesContaining,
  resolveCommit,
  rewriteCheckSchema,
  shortSha,
  type RewriteCheck,
} from "../rewrite"
import { readStack, topBranch } from "../stack"

/** How many remote branches holding the commit a result lists. */
const MAX_REMOTE_BRANCHES = 20

const RECOMMENDATIONS = ["amend", "fixup", "new_commit"] as const

const FORCE_PUSH_CLAUSE = ", then force-push the branch with a lease"

/** How to correct a commit: amend it, fix it up, or make a new commit. */
export const amendCheckSchema = z.object({
  sha: z.string().describe("The full id of the commit checked."),
  is_head: z.boolean().describe("True when the commit is HEAD."),
  on_branch: z.boolean().describe("True when the commit is HEAD or one of its ancestors."),
  pushed: z.boolean().describe("True when any remote branch holds the commit."),
  remote_branches: z
    .array(z.string())
    .describe(`The remote branches that hold the commit, such as origin/feat; at most ${MAX_REMOTE_BRANCHES}.`),
  recommendation: z
    .enum(RECOMMENDATIONS)
    .describe(
      '"amend" for HEAD, "fixup" for an earlier commit of this branch (on a stack, a commit of a lower layer is fixed up on the top and the whole stack rebased), "new_commit" when the rewrite rule refuses or the commit is not on this branch.',
    ),
  reason: z.string().describe("What to do next, in plain words."),
  needs_force_push: rewriteCheckSchema.shape.needs_force_push,
  refusals: rewriteCheckSchema.shape.refusals,
  warnings: rewriteCheckSchema.shape.warnings,
})

type AmendCheck = z.output<typeof amendCheckSchema>

/** The verdict the recommendation rests on, and the reason when it differs from the plain one. */
type Verdict = { check: RewriteCheck | null; reason?: string }

/** Whether the only thing in the way is that layers sit above the branch (or share its tip). */
function onlyLayersAbove(check: RewriteCheck): boolean {
  return !check.allowed && check.refusals.every((refusal) => refusal.rule === "layers_above")
}

/**
 * The verdict for a commit of a stack's lower layer: when only the layers above
 * refuse, a fixup committed on the top and folded in by rebasing the whole
 * stack is recommended if that rewrite is allowed.
 */
async function stackVerdict(
  root: string,
  full: string,
  check: RewriteCheck,
  signal: AbortSignal | undefined,
): Promise<Verdict> {
  let whole: RewriteCheck
  try {
    whole = await checkRewrite(root, full, { signal, wholeStack: true })
  } catch (error) {
    if (!isToolError(error) || error.code !== "invalid_argument") throw error
    return { check }
  }
  if (!whole.allowed) return { check: whole }
  const stack = await readStack(root, { signal })
  if (!stack) return { check }
  const top = topBranch(stack)
  const forcePush = whole.needs_force_push ? FORCE_PUSH_CLAUSE : ""
  const where = stack.branch === top ? "commit the fix here" : `check out ${top}, commit the fix there`
  return {
    check: whole,
    reason: `Branches of a stack sit on or above this commit; ${where} with git_commit_create (fixup: ${shortSha(full)}), then fold it in with an autosquash rebase of the stack${forcePush}.`,
  }
}

/** The recommendation and its reason, from the commit's place and the rewrite rule's verdict (null when the commit is not on the branch). */
function recommend(sha: string, isHead: boolean, verdict: Verdict): Pick<AmendCheck, "recommendation" | "reason"> {
  const { check } = verdict
  if (!check) {
    return {
      recommendation: "new_commit",
      reason: `${shortSha(sha)} is not on this branch; make a new commit that fixes it.`,
    }
  }
  if (!check.allowed) {
    return { recommendation: "new_commit", reason: check.refusals.map((refusal) => refusal.message).join(" ") }
  }
  if (verdict.reason) return { recommendation: "fixup", reason: verdict.reason }
  const forcePush = check.needs_force_push ? FORCE_PUSH_CLAUSE : ""
  if (isHead) {
    return { recommendation: "amend", reason: `HEAD of this branch; amend it with git_commit_amend${forcePush}.` }
  }
  return {
    recommendation: "fixup",
    reason: `An earlier commit of this branch; commit the fix with git_commit_create (fixup: ${shortSha(sha)}), then fold it in with an autosquash rebase${forcePush}.`,
  }
}

/**
 * Classifies how to correct a commit: `amend` when it is HEAD, `fixup` for an
 * earlier commit of this branch, `new_commit` when the rewrite rule refuses or
 * the commit is not on this branch (the rule is then not run). Reads only; an
 * unknown commit throws `not_found`.
 */
export async function readAmendCheck(root: string, sha: string, signal?: AbortSignal): Promise<AmendCheck> {
  const full = await resolveCommit(root, sha, signal)
  const head = (await git(["rev-parse", "HEAD"], { cwd: root, signal })).trim()
  const isHead = full === head
  const onBranch = isHead || (await isAncestor(root, full, "HEAD", signal))
  const remoteBranches = await remoteBranchesContaining(root, [full], signal)
  let verdict: Verdict = { check: null }
  if (onBranch) {
    const check = await checkRewrite(root, full, { signal, amending: isHead })
    verdict = onlyLayersAbove(check) ? await stackVerdict(root, full, check, signal) : { check }
  }
  const { check } = verdict
  return {
    sha: full,
    is_head: isHead,
    on_branch: onBranch,
    pushed: remoteBranches.length > 0,
    remote_branches: remoteBranches.slice(0, MAX_REMOTE_BRANCHES),
    ...recommend(full, isHead, verdict),
    needs_force_push: check?.needs_force_push ?? false,
    refusals: check?.refusals ?? [],
    warnings: check?.warnings ?? [],
  }
}
