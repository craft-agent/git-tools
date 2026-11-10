import { git, gitResult } from "../git"
import { REMOTE_REFS_PREFIX } from "../rewrite"
import { isAncestor } from "../tree"
import type { BranchState } from "./branch-state"
import type { SelectedBranch } from "./select"

async function dirtyWarning(root: string, signal?: AbortSignal): Promise<string[]> {
  const status = await git(["status", "--porcelain", "--untracked-files=no"], { cwd: root, signal })
  const files = status.split("\n").filter(Boolean).length
  return files > 0 ? [`${files} tracked file(s) have uncommitted changes; they are not pushed.`] : []
}

/** The branches among `pushed` that do not contain the tip of `<remote>/<default>` as this repository knows it, in one warning. */
async function behindWarning(
  root: string,
  remote: string,
  defaultBranch: string | null,
  pushed: BranchState[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (defaultBranch === null) return []
  const ref = `${remote}/${defaultBranch}`
  const known = await gitResult(["rev-parse", "--verify", "--quiet", `${REMOTE_REFS_PREFIX}${ref}^{commit}`], {
    cwd: root,
    signal,
  })
  if (known.code !== 0) return []
  const behind: string[] = []
  for (const { branch, sha } of pushed) {
    if (!(await isAncestor(root, known.stdout.trim(), sha, signal))) behind.push(branch)
  }
  if (behind.length === 0) return []
  return [
    `${behind.join(", ")} ${behind.length === 1 ? "is" : "are"} behind ${ref}; rebase ${behind.length === 1 ? "it" : "them"} first if a pull request should be current.`,
  ]
}

/** The warnings for branches among `pushed` that add nothing over the branch below them in the line. */
async function noOwnCommitsWarnings(
  root: string,
  selected: Map<string, SelectedBranch>,
  pushed: BranchState[],
  signal?: AbortSignal,
): Promise<string[]> {
  const warnings: string[] = []
  for (const { branch, sha } of pushed) {
    const { below, sameAs } = selected.get(branch)!
    if (sameAs !== null) {
      warnings.push(`${branch} is at the same commit as ${sameAs}, so it has no commits of its own.`)
    } else if (below !== null) {
      const own = await git(["rev-list", "--count", sha, "--not", below.sha], { cwd: root, signal })
      if (Number(own.trim()) === 0) warnings.push(`${branch} has no commits of its own over ${below.name}.`)
    }
  }
  return warnings
}

/**
 * What does not stop a push but is worth knowing: tracked uncommitted changes
 * (they are not pushed), branches that do not contain the remote's default
 * branch, branches with no commits of their own over the branch below them (or
 * the default branch), and the commits a force push drops. Only branches that
 * are pushed, and are not the default branch, count for the middle two.
 */
export async function previewWarnings(
  root: string,
  remote: string,
  defaultBranch: string | null,
  selected: SelectedBranch[],
  states: BranchState[],
  signal?: AbortSignal,
): Promise<string[]> {
  const pushed = states.filter((state) => state.kind !== "none" && state.branch !== defaultBranch)
  const drops = states.flatMap((state) =>
    state.drops !== null && state.drops.length > 0
      ? [
          `The force push of ${state.branch} drops ${state.drops.length} commit(s) of ${remote}/${state.branch} whose change is not on it; see drops.`,
        ]
      : [],
  )
  return [
    ...(await dirtyWarning(root, signal)),
    ...(await behindWarning(root, remote, defaultBranch, pushed, signal)),
    ...(await noOwnCommitsWarnings(root, new Map(selected.map((entry) => [entry.branch, entry])), pushed, signal)),
    ...drops,
  ]
}
