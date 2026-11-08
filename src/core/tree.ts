import { existsSync } from "node:fs"
import { ToolError } from "./errors"
import { git, gitResult, repositoryRoot } from "./git"
import { isWithin } from "./paths"
import type { ToolContext } from "./tool"

/**
 * Resolves the absolute working tree root containing `ctx.cwd`.
 *
 * Refuses calls where `ctx.cwd` is inside the tools' install directory (`ctx.ownDir`),
 * throwing a `not_a_repository` error without running git.
 */
export async function workingTree(ctx: Pick<ToolContext, "cwd" | "signal" | "ownDir">): Promise<string> {
  if (ctx.ownDir && (await isWithin(ctx.cwd, ctx.ownDir))) {
    throw new ToolError(
      "not_a_repository",
      `${ctx.cwd} is where these tools are installed, not a project; run the call inside the project's working tree.`,
    )
  }
  return repositoryRoot({ cwd: ctx.cwd, signal: ctx.signal })
}

/** An in-progress git operation that paused for conflicts or manual intervention. */
export type Operation = "rebase" | "am" | "merge" | "cherry-pick" | "revert" | "bisect"

const OPERATION_MARKERS = [
  ["rebase-merge", "rebase"],
  ["rebase-apply/applying", "am"],
  ["rebase-apply", "rebase"],
  ["MERGE_HEAD", "merge"],
  ["CHERRY_PICK_HEAD", "cherry-pick"],
  ["REVERT_HEAD", "revert"],
  ["BISECT_LOG", "bisect"],
] as const satisfies readonly (readonly [string, Operation])[]

/**
 * Checks whether an interactive or multi-step operation is in progress in the working tree.
 *
 * Runs a single `git rev-parse` with `--git-path` arguments to resolve per-worktree paths,
 * then checks existence in precedence order.
 */
export async function operationInProgress(root: string, signal?: AbortSignal): Promise<Operation | null> {
  const args = [
    "rev-parse",
    "--path-format=absolute",
    ...OPERATION_MARKERS.flatMap(([marker]) => ["--git-path", marker]),
  ]
  const output = await git(args, { cwd: root, signal })
  const lines = output.trim().split("\n")
  for (let i = 0; i < OPERATION_MARKERS.length; i++) {
    const path = lines[i]
    if (path && existsSync(path)) return OPERATION_MARKERS[i]![1]
  }

  return null
}

/**
 * Resolves an absolute path inside the git directory for `name`, resolving per-worktree paths.
 */
export async function gitPath(root: string, name: string, signal?: AbortSignal): Promise<string> {
  const out = await git(["rev-parse", "--path-format=absolute", "--git-path", name], {
    cwd: root,
    signal,
  })
  return out.trim()
}

/**
 * The remote default branch as recorded locally; reads no remote.
 *
 * Checks `refs/remotes/origin/HEAD` first, then falls back to `origin/main` or `origin/master`.
 */
export async function defaultBranchRef(root: string, signal?: AbortSignal): Promise<string | null> {
  const head = await gitResult(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], {
    cwd: root,
    signal,
  })
  if (head.code === 0 && head.stdout.trim()) {
    return head.stdout.trim()
  }
  for (const ref of ["origin/main", "origin/master"]) {
    const check = await gitResult(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], {
      cwd: root,
      signal,
    })
    if (check.code === 0) {
      return ref
    }
  }
  return null
}
