import { git, gitResult } from "../git"
import { isAncestor } from "../tree"
import type { PushKind } from "./schema"
import type { SelectedBranch } from "./select"

/** A commit with its subject. */
export type CommitLine = { sha: string; subject: string }

/** How one branch stands to its remote branch. */
export type BranchState = {
  branch: string
  /** The full id of the local tip. */
  sha: string
  /** The full id of the commit the remote branch is at; null when the remote has no such branch. */
  expect: string | null
  kind: PushKind
  /** False only when the remote branch is at a commit this repository does not have; true when it has none. */
  known: boolean
  /** Every commit the remote lacks, oldest first. */
  commits: CommitLine[]
  /** For a force push over a known remote commit: the remote commits whose change is not on the local branch, oldest first. Null otherwise. */
  drops: CommitLine[] | null
}

/** The commits `git log --reverse --topo-order <args>` selects, with their subjects. */
async function commitLines(root: string, args: string[], signal?: AbortSignal): Promise<CommitLine[]> {
  const out = await git(["log", "--reverse", "--topo-order", "--format=%H%x00%s", ...args], { cwd: root, signal })
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\0")
      return { sha, subject }
    })
}

/** Whether this repository has the commit `sha`. */
export async function hasCommit(root: string, sha: string, signal?: AbortSignal): Promise<boolean> {
  return (await gitResult(["cat-file", "-e", `${sha}^{commit}`], { cwd: root, signal })).code === 0
}

/** The commits of `remoteTip` whose change `git cherry` does not find on `tip`, oldest first. */
async function droppedCommits(
  root: string,
  tip: string,
  remoteTip: string,
  signal?: AbortSignal,
): Promise<CommitLine[]> {
  const cherry = await git(["cherry", tip, remoteTip], { cwd: root, signal })
  const unmatched = new Set(
    cherry
      .split("\n")
      .filter((line) => line.startsWith("+ "))
      .map((line) => line.slice(2).trim()),
  )
  if (unmatched.size === 0) return []
  return (await commitLines(root, [`${tip}..${remoteTip}`], signal)).filter((commit) => unmatched.has(commit.sha))
}

/**
 * How `selected` stands to the remote branch at `expect` (null: the remote has
 * none): `none` when they are equal, `create` for a new remote branch,
 * `fast_forward` when the remote commit is here and an ancestor of the tip,
 * else `force`. The commits the remote lacks are those of the tip that are
 * neither under the remote commit (when it is here) nor on any remote-tracking
 * branch of `remote`.
 */
export async function compareBranch(
  root: string,
  remote: string,
  selected: SelectedBranch,
  expect: string | null,
  signal?: AbortSignal,
): Promise<BranchState> {
  const { branch, sha } = selected
  if (expect === sha) return { branch, sha, expect, kind: "none", known: true, commits: [], drops: null }

  const held = expect !== null && (await hasCommit(root, expect, signal)) ? expect : null
  let kind: PushKind = "force"
  if (expect === null) kind = "create"
  else if (held !== null && (await isAncestor(root, held, sha, signal))) kind = "fast_forward"

  const commits = await commitLines(
    root,
    [sha, "--not", ...(held === null ? [] : [held]), `--remotes=${remote}`],
    signal,
  )
  const drops = kind === "force" && held !== null ? await droppedCommits(root, sha, held, signal) : null
  return { branch, sha, expect, kind, known: expect === null || held !== null, commits, drops }
}
