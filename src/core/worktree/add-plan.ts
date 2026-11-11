import { lstat } from "node:fs/promises"
import { ToolError } from "../errors"
import { gitResult } from "../git"
import { LOCAL_BRANCH_PREFIX, listWorktrees } from "../worktrees"
import { repositoryName, worktreePath } from "./layout"

/** The remote a new branch is cut from and fetched out of. */
export const ORIGIN_REMOTE = "origin"

const OPTION_PREFIX = "-"

/** What a call to add a worktree asks for. */
export type AddRequest = {
  /** The working tree the call is made from; the repository the worktree joins. */
  callerRoot: string
  /** Where task worktrees go (the layout's root). */
  worktreeRoot: string
  branch: string
  /** The starting commit, branch or tag, for a new branch only. */
  from?: string
  signal?: AbortSignal
}

/** What the local checks of a request settled, before anything is fetched or created. */
export type AddPlan = {
  /** The directory the worktree goes in, by the layout. */
  target: string
  branch: string
  /** The starting ref as given; always absent for an existing branch. */
  from?: string
  /** Whether the branch does not exist yet. */
  newBranch: boolean
}

function invalidBranch(branch: string): ToolError {
  return new ToolError(
    "invalid_argument",
    `"${branch}" is not a valid branch name; use something like task/short-name.`,
  )
}

/** Throws `invalid_argument` unless `branch` is a plain branch name git accepts (not blank, not an option, not a `@{-1}` style shorthand). */
async function requireBranchName(root: string, branch: string, signal?: AbortSignal): Promise<void> {
  if (branch.trim() === "" || branch.startsWith(OPTION_PREFIX)) throw invalidBranch(branch)
  const result = await gitResult(["check-ref-format", "--branch", branch], { cwd: root, signal })
  if (result.code !== 0 || result.stdout.trim() !== branch) throw invalidBranch(branch)
}

/** Throws `invalid_argument` unless `from`, when given, is not blank and not an option. */
function requireFrom(from: string | undefined): void {
  if (from !== undefined && (from.trim() === "" || from.startsWith(OPTION_PREFIX))) {
    throw new ToolError(
      "invalid_argument",
      `"${from}" is not a usable starting point; pass a branch, tag or commit, or leave from out.`,
    )
  }
}

/** Whether anything, even a dangling symlink, is at `path`. */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

/** Whether the repository has a remote named `origin`. */
export async function hasOrigin(root: string, signal?: AbortSignal): Promise<boolean> {
  return (await gitResult(["remote", "get-url", ORIGIN_REMOTE], { cwd: root, signal })).code === 0
}

/**
 * Where the worktree of `request.branch` goes by the layout. Throws
 * `invalid_argument` for a branch name git does not accept, so a refused name
 * never names a directory.
 */
export async function targetOf(
  request: Pick<AddRequest, "callerRoot" | "worktreeRoot" | "branch" | "signal">,
): Promise<string> {
  const { callerRoot, worktreeRoot, branch, signal } = request
  await requireBranchName(callerRoot, branch, signal)
  return worktreePath(worktreeRoot, await repositoryName(callerRoot, signal), branch)
}

/** Throws `invalid_argument` when `branch` is checked out in a worktree of the repository, naming the directory. */
async function requireNotCheckedOut(root: string, branch: string, signal?: AbortSignal): Promise<void> {
  const holder = (await listWorktrees(root, signal)).find((entry) => entry.branch === `${LOCAL_BRANCH_PREFIX}${branch}`)
  if (holder === undefined) return
  const pruneHint = holder.prunable === null ? "" : " (its directory is gone; git worktree prune clears it)"
  throw new ToolError(
    "invalid_argument",
    `${branch} is already checked out in ${holder.path}${pruneHint}; use that worktree, or pick another branch name.`,
  )
}

/**
 * The local checks of a request, which read this repository alone: the branch
 * and `from` are usable, the layout's directory is free, and an existing
 * branch is given no starting point and is not checked out anywhere. Nothing
 * is fetched or created. Throws `invalid_argument` when one fails.
 */
export async function planAdd(request: AddRequest): Promise<AddPlan> {
  const { callerRoot, branch, from, signal } = request
  requireFrom(from)
  const target = await targetOf(request)
  if (await pathExists(target)) {
    throw new ToolError(
      "invalid_argument",
      `${target} already exists; pick another branch name, or remove that worktree first.`,
    )
  }

  const branchExists =
    (
      await gitResult(["show-ref", "--verify", "--quiet", `${LOCAL_BRANCH_PREFIX}${branch}`], {
        cwd: callerRoot,
        signal,
      })
    ).code === 0
  if (!branchExists) return { target, branch, from, newBranch: true }
  if (from !== undefined) {
    throw new ToolError(
      "invalid_argument",
      `${branch} already exists, so it cannot be cut from ${from}; leave from out to check it out as it is, or pick a new branch name.`,
    )
  }
  await requireNotCheckedOut(callerRoot, branch, signal)
  return { target, branch, newBranch: false }
}
