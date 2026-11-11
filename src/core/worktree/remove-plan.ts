import { resolve } from "node:path"
import { ToolError } from "../errors"
import { isWithin, realpathOfExisting } from "../paths"
import { branchName, listWorktrees, type ListedWorktree } from "../worktrees"
import { requireNoOperation, requireNoUncommittedFiles, requireNoUnheldCommits } from "./remove-checks"

/** What a call to remove a worktree asks for. */
export type RemoveRequest = {
  /** The working tree the call is made from; the repository whose worktree goes. */
  callerRoot: string
  /** The directory the call is made from, which may not be in the worktree to remove; `callerRoot` when absent. */
  callerDirectory?: string
  /** Where task worktrees go (the layout's root). */
  worktreeRoot: string
  /** The worktree's directory, absolute or relative to `callerRoot`. */
  directory: string
  /** Skips the check for modified, staged and untracked files, and passes `--force` to git once; never from a tool's input. */
  force?: boolean
  signal?: AbortSignal
}

/** What the local checks of a request settled, before anything is fetched or removed. */
export type RemovePlan = {
  /** The real path of the worktree's directory (as resolved when it is gone). */
  directory: string
  /** The path as `git worktree list` prints it, which names the worktree to git. */
  listedPath: string
  /** The branch checked out; null when HEAD is detached. */
  branch: string | null
  /** The full id of the commit checked out; null for a bare repository. */
  tip: string | null
  /** Whether the directory is gone, so only git's record of the worktree is pruned. */
  gone: boolean
}

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/**
 * Where the worktree `request.directory` names is: the path resolved against
 * the caller's working tree, with the part that exists as a real path.
 * Throws `invalid_argument` for a blank directory.
 */
export async function targetOf(request: Pick<RemoveRequest, "callerRoot" | "directory">): Promise<string> {
  if (request.directory.trim() === "") {
    throw invalid("directory is blank; pass the directory of the worktree to remove.")
  }
  return realpathOfExisting(resolve(request.callerRoot, request.directory))
}

/** The worktree of the repository whose directory is `target`, compared by real path; `not_found` when there is none. */
async function findWorktree(request: RemoveRequest, target: string): Promise<ListedWorktree> {
  for (const entry of await listWorktrees(request.callerRoot, request.signal)) {
    if ((await realpathOfExisting(entry.path)) === target) return entry
  }
  throw new ToolError("not_found", `${target} is not a worktree of this repository.`)
}

/** Throws `invalid_argument` for a worktree that must not be removed: the main one, the one the call is made from, a locked one. */
async function requireRemovable(request: RemoveRequest, entry: ListedWorktree, target: string): Promise<void> {
  const { callerRoot, callerDirectory = callerRoot } = request
  if (entry.main) {
    throw invalid(`${target} is the main working tree of the repository, which is never removed.`)
  }
  if ((await isWithin(callerDirectory, target)) || (await isWithin(callerRoot, target))) {
    throw invalid(`The call was made from inside ${target}; make it from another working tree of the repository.`)
  }
  if (entry.locked !== null) {
    const reason = entry.locked === "" ? "" : ` (${entry.locked})`
    throw invalid(`${target} is locked${reason}; unlocking it with git worktree unlock is the person's call.`)
  }
}

/**
 * The local checks of a request, which read this repository and the worktree
 * alone: the directory is a worktree of the repository, not the main working
 * tree, not the one the call is made from and not locked; and, when its
 * directory exists, no operation is in progress in it, it has no modified,
 * staged or untracked files (unless `force`; ignored files do not count), and
 * a detached HEAD is not at commits nothing else holds. Nothing is fetched or
 * removed. Throws `not_found`, `invalid_argument`, `operation_in_progress` or
 * `dirty_tree`.
 */
export async function planRemove(request: RemoveRequest): Promise<RemovePlan> {
  const { force = false, signal } = request
  const target = await targetOf(request)
  const entry = await findWorktree(request, target)
  await requireRemovable(request, entry, target)

  const gone = entry.prunable !== null
  if (!gone) {
    await requireNoOperation(target, signal)
    if (!force) await requireNoUncommittedFiles(target, signal)
    if (entry.detached) await requireNoUnheldCommits(target, signal)
  }
  return {
    directory: target,
    listedPath: entry.path,
    branch: branchName(entry.branch),
    tip: entry.head,
    gone,
  }
}
