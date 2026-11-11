import { git } from "../git"
import type { CallDescription, CallFact, CallHeadline } from "../tool"
import type { RemovePlan } from "./remove-plan"

/** How many paths git lists as ignored in the working tree `directory`, a folder of them counting as one. */
async function ignoredPathCount(directory: string, signal?: AbortSignal): Promise<number> {
  const listing = await git(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"], {
    cwd: directory,
    signal,
  })
  return listing.split("\0").filter(Boolean).length
}

/** The `Ignored files` fact: how many ignored paths the removal deletes with the directory, as `1 path lost` or `3 paths lost`. */
function ignoredFact(count: number): CallFact {
  return {
    label: "Ignored files",
    value: { text: count === 1 ? "{count} path lost" : "{count} paths lost", values: { count } },
  }
}

/** The headline for removing (or, for a directory already gone, pruning) the worktree of the branch, or of a detached HEAD. */
function headlineOf(plan: RemovePlan): CallHeadline {
  if (plan.branch === null) {
    return { text: plan.gone ? "About to prune a detached worktree" : "About to remove a detached worktree" }
  }
  return {
    text: plan.gone ? "About to prune the worktree of {branch}" : "About to remove the worktree of {branch}",
    values: { branch: plan.branch },
  }
}

/**
 * What a call of `git_worktree_remove` will do, for the person approving it,
 * from the local checks alone: removing the worktree of a branch (or a detached
 * one), or pruning one whose directory is gone, and how many ignored paths
 * go with it. The directory is the call's target, and the arguments name
 * everything the call relies on, so there are no pins.
 */
export async function removeDescription(plan: RemovePlan, signal?: AbortSignal): Promise<CallDescription> {
  const ignored = plan.gone ? 0 : await ignoredPathCount(plan.directory, signal)
  return { headline: headlineOf(plan), facts: ignored > 0 ? [ignoredFact(ignored)] : [] }
}
