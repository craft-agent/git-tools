import { branchFact, newBranchFact } from "../git-facts"
import type { CallDescription } from "../tool"
import { defaultBranchRef } from "../tree"
import { hasOrigin, type AddPlan, type AddRequest } from "./add-plan"

const HEAD_REF = "HEAD"

/**
 * Where a new branch will start, by what this repository knows (nothing is
 * fetched or read from the remote): `from`, else the default branch of
 * `origin` as last recorded, else `HEAD`.
 */
async function describedBase(request: AddRequest, plan: AddPlan): Promise<string> {
  const { callerRoot, signal } = request
  if (plan.from !== undefined) return plan.from
  if (!(await hasOrigin(callerRoot, signal))) return HEAD_REF
  return (await defaultBranchRef(callerRoot, signal)) ?? HEAD_REF
}

/**
 * What a call of `git_worktree_add` will do, for the person approving it, from
 * the local checks alone: whether the branch is new and where it starts, or
 * the existing branch that is checked out. The directory is the call's target,
 * and the arguments name everything the call relies on, so there are no pins.
 */
export async function addDescription(request: AddRequest, plan: AddPlan): Promise<CallDescription> {
  return {
    headline: { text: "About to add a worktree for {branch}", values: { branch: plan.branch } },
    facts: [plan.newBranch ? newBranchFact(plan.branch, await describedBase(request, plan)) : branchFact(plan.branch)],
  }
}
