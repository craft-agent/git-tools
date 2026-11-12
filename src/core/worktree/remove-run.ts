import { rmdir } from "node:fs/promises"
import { dirname, join } from "node:path"
import { isToolError, ToolError } from "../errors"
import { git } from "../git"
import { realpathOfExisting } from "../paths"
import { LOCAL_BRANCH_PREFIX, listWorktrees } from "../worktrees"
import { CONVENTIONAL_DEFAULTS, originDefault } from "./add-run"
import { hasOrigin, ORIGIN_REMOTE } from "./add-plan"
import { repositoryName } from "./layout"
import { provenLanded } from "./landed"
import type { RemovePlan, RemoveRequest } from "./remove-plan"
import type { RemovedWorktree } from "./remove-schema"

/** What became of the branch of a removed worktree: the result's fields about it. */
type BranchOutcome = Pick<RemovedWorktree, "landed" | "branch_deleted" | "kept_because" | "warnings">

/** An outcome that keeps the branch, `because`; `landed` and `warnings` when the proof was looked for. */
function kept(
  because: NonNullable<RemovedWorktree["kept_because"]>,
  landed: RemovedWorktree["landed"] = null,
  warnings: string[] = [],
): BranchOutcome {
  return { landed, branch_deleted: false, kept_because: because, warnings }
}

/** Removes the worktree with `git worktree remove`, or prunes git's record of it when its directory is gone. */
async function removeWorktreeRecord(request: RemoveRequest, plan: RemovePlan): Promise<void> {
  const { callerRoot, force = false, signal } = request
  if (!plan.gone) {
    await git(["worktree", "remove", ...(force ? ["--force"] : []), plan.listedPath], { cwd: callerRoot, signal })
    return
  }
  await git(["worktree", "prune"], { cwd: callerRoot, signal })
  if ((await listWorktrees(callerRoot, signal)).some((entry) => entry.path === plan.listedPath)) {
    throw new ToolError("git_error", `git worktree prune left the record of ${plan.directory}; it may be locked.`)
  }
}

/** Removes the folder of the repository under the layout's root when the removed worktree sat directly in it and it is now empty. */
async function removeEmptyLayoutFolder(request: RemoveRequest, plan: RemovePlan): Promise<void> {
  const { callerRoot, worktreeRoot, signal } = request
  const folder = await realpathOfExisting(join(worktreeRoot, await repositoryName(callerRoot, signal)))
  const parent = dirname(plan.directory)
  if ((await realpathOfExisting(parent)) !== folder) return
  try {
    await rmdir(parent)
  } catch {
    // Still holds other worktrees (or is already gone): either way it stays as it is.
  }
}

/** Whether `branch` is the default branch: the one `origin` names, else `main` or `master`; with no `origin`, `main` or `master`. */
async function isDefaultBranch(root: string, branch: string, signal?: AbortSignal): Promise<boolean> {
  const base = (await hasOrigin(root, signal)) ? await originDefault(root, signal) : null
  return base === null ? CONVENTIONAL_DEFAULTS.includes(branch) : base.ref === `${ORIGIN_REMOTE}/${branch}`
}

/** Whether another worktree still has `branch` checked out (git allows it only with `worktree add --force`). */
async function isCheckedOut(root: string, branch: string, signal?: AbortSignal): Promise<boolean> {
  return (await listWorktrees(root, signal)).some((entry) => entry.branch === `${LOCAL_BRANCH_PREFIX}${branch}`)
}

/** The commit `branch` points at now, or null when it no longer exists. */
async function currentTip(root: string, branch: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return (await git(["rev-parse", "--verify", `${LOCAL_BRANCH_PREFIX}${branch}`], { cwd: root, signal })).trim()
  } catch (error) {
    if (!isToolError(error)) throw error
    return null
  }
}

/**
 * Deletes the branch of the removed worktree when it is proven to have
 * landed; otherwise keeps it and says why. The branch of a detached worktree,
 * the default branch and a branch still checked out elsewhere are never
 * looked at.
 */
async function settleBranch(request: RemoveRequest, plan: RemovePlan): Promise<BranchOutcome> {
  const { callerRoot, signal } = request
  const { branch, tip } = plan
  if (branch === null) return kept("detached")
  if (await isDefaultBranch(callerRoot, branch, signal)) return kept("default_branch")
  if (await isCheckedOut(callerRoot, branch, signal)) return kept("checked_out")
  if (tip === null) return kept("not_landed")

  const { landed, warnings } = await provenLanded({ root: callerRoot, branch, tip, signal })
  if (landed === null) return kept("not_landed", null, warnings)
  if (await isCheckedOut(callerRoot, branch, signal)) return kept("checked_out")
  try {
    await git(["update-ref", "-d", `${LOCAL_BRANCH_PREFIX}${branch}`, tip], { cwd: callerRoot, signal })
  } catch (error) {
    if (!isToolError(error)) throw error
    const failure = [...warnings, `could not delete ${branch}: ${error.message}`]
    const current = await currentTip(callerRoot, branch, signal)
    if (current !== null && current !== tip) return kept("moved", landed, failure)
    return kept("delete_failed", landed, current === null ? [...failure, `${branch} is gone`] : failure)
  }
  return { landed, branch_deleted: true, kept_because: null, warnings }
}

/**
 * Removes the planned worktree (see `planRemove`), then the folder of the
 * layout if it is left empty, then settles its branch. Throws `git_error`
 * when git refuses the removal.
 */
export async function removePlanned(request: RemoveRequest, plan: RemovePlan): Promise<RemovedWorktree> {
  await removeWorktreeRecord(request, plan)
  await removeEmptyLayoutFolder(request, plan)
  return {
    directory: plan.directory,
    branch: plan.branch,
    pruned: plan.gone,
    ...(await settleBranch(request, plan)),
  }
}
