import { readForcePushRule, shortSha, type ForcePushReads } from "../rewrite"
import { operationInProgress } from "../tree"
import type { BranchState } from "./branch-state"
import type { PushRefusal } from "./schema"

/**
 * The reasons a push of `states` would be refused, and the warnings of the
 * reads that went with them. Refused: the remote's default branch (when known),
 * an operation in progress, a force push onto a branch GitHub protects against
 * force pushes (read as the rewrite rule reads it, only for a GitHub remote)
 * and a force push over a remote commit this repository does not have. A
 * protection read that fails is a warning.
 */
export async function findRefusals(
  root: string,
  remote: string,
  defaultBranch: string | null,
  states: BranchState[],
  signal?: AbortSignal,
): Promise<{ refusals: PushRefusal[]; warnings: string[] }> {
  const refusals: PushRefusal[] = []
  const warnings: string[] = []

  const operation = await operationInProgress(root, signal)
  if (operation) {
    refusals.push({
      rule: "operation",
      branch: null,
      message: `A ${operation} is in progress; finish or abort it before pushing.`,
    })
  }

  const reads: ForcePushReads = new Map()
  for (const state of states) {
    const { branch } = state
    if (branch === defaultBranch) {
      refusals.push({
        rule: "default_branch",
        branch,
        message: `${branch} is the default branch of ${remote}; it is not pushed from here. Push a branch of your own instead.`,
      })
    } else if (state.kind === "force" && !state.known) {
      refusals.push({
        rule: "unknown_remote_commit",
        branch,
        message: `${remote}/${branch} is at ${shortSha(state.expect!)}, which is not here: someone else may have pushed it; fetch and rebase first.`,
      })
    } else if (state.kind === "force") {
      const own = { remote, name: branch, ref: `${remote}/${branch}` }
      const rule = await readForcePushRule(root, own, reads, signal)
      if (rule.status === "protected") refusals.push({ rule: "protected", branch, message: rule.message })
      else if (rule.status === "unreadable") warnings.push(rule.message)
    }
  }
  return { refusals, warnings }
}
