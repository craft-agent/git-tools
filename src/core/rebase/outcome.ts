import { AUTOSQUASH_PATTERN } from "../commit/message-rules"
import { readConflictMap } from "../conflicts"
import type { ExecResult } from "../exec"
import { classifyGitFailure, git, gitResult } from "../git"
import { ownRemoteRefs, REMOTE_REFS_PREFIX, shortSha } from "../rewrite"
import { currentBranch, isAncestor, operationInProgress } from "../tree"
import { OUTPUT_TAIL_LINES, type RebaseOutcome, type StoppedCommit } from "./outcome-schema"
import { HEADS_PREFIX, type LayerTip } from "./rebase-state"

/** How long a rebase step may run, the hooks of every replayed commit included. */
export const REBASE_TIMEOUT_MS = 600_000

/** Git's own words for a commit that has nothing left to apply. */
const EMPTY_PATTERN = /is now empty|nothing to commit|nothing added to commit/i

/** Hint and todo lines quote commit subjects, so they are filtered out before `EMPTY_PATTERN` is tried. */
const NOT_GIT_WORDS_PATTERN = /^\s*(hint:|(pick|fixup|squash|reword|edit|drop|exec) )/

/** The tool the next-step texts send the caller to. */
const RESUME_TOOL = "git_rebase_resume"

/** The part of a git run the outcome reads. */
export type GitRun = Pick<ExecResult, "code" | "stdout" | "stderr">

/** What the outcome function needs to know of a rebase git just ran. */
export type OutcomeInput = {
  run: GitRun
  top: string
  /** The layer branches the rebase moves, bottom to top, with their tips before it. */
  before: LayerTip[]
  /** What it goes onto, with the full id; null when not known. */
  onto: { ref: string | null; sha: string } | null
  /** How many autosquash commits the replayed range held before; null when not known. */
  fixupsBefore: number | null
  warnings: string[]
  /** The run was `rebase --abort`: a finished run means the branches are back, not that the rebase is done. */
  aborting?: boolean
  /** The conflicted files that still hold conflict markers, when nothing was run because of them. */
  unresolved?: string[]
}

/** The last `OUTPUT_TAIL_LINES` lines of what git printed. */
function tail(run: GitRun): string {
  return `${run.stdout}\n${run.stderr}`.trim().split("\n").slice(-OUTPUT_TAIL_LINES).join("\n")
}

/** The paths git lists as unmerged, relative to the working tree root. */
export async function unmergedPaths(root: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(["diff", "--name-only", "--diff-filter=U", "-z"], { cwd: root, signal })
  return out.split("\0").filter(Boolean)
}

/** The commit a stopped rebase is replaying, as `REBASE_HEAD` names it; null when none. */
export async function stoppedCommit(root: string, signal?: AbortSignal): Promise<StoppedCommit | null> {
  const stopped = await gitResult(["log", "-1", "--format=%H%x00%s", "REBASE_HEAD"], { cwd: root, signal })
  if (stopped.code !== 0) return null
  const [sha = "", subject = ""] = stopped.stdout.replace(/\n$/, "").split("\0")
  return { sha: shortSha(sha), subject }
}

/** Whether git's own words, apart from hint and todo lines, say the commit became empty. */
function saysEmpty(output: string): boolean {
  return EMPTY_PATTERN.test(
    output
      .split("\n")
      .filter((line) => !NOT_GIT_WORDS_PATTERN.test(line))
      .join("\n"),
  )
}

function nextStep(reason: NonNullable<RebaseOutcome["paused"]>["reason"], unresolved: boolean): string {
  if (unresolved) {
    return `These files still hold conflict markers: resolve them, then call ${RESUME_TOOL} with action "continue" again.`
  }
  if (reason === "conflicts") {
    return `Resolve the conflicted files (${RESUME_TOOL} with action "continue" stages the ones you resolved), then call it with action "continue"; action "skip" drops this commit, action "abort" restores the branches.`
  }
  if (reason === "empty") {
    return `Nothing is left of this commit (its change is already in the base): ${RESUME_TOOL} with action "skip" drops it; action "abort" restores the branches.`
  }
  return `Fix what the output names, then call ${RESUME_TOOL} with action "continue"; action "abort" restores the branches.`
}

/** The tip each branch of `before` has now, as short ids; a branch that no longer exists is left out. */
async function layersNow(root: string, before: LayerTip[], signal?: AbortSignal): Promise<RebaseOutcome["layers"]> {
  const layers: RebaseOutcome["layers"] = []
  for (const { branch, sha } of before) {
    const now = await gitResult(["rev-parse", "--verify", "--quiet", `${HEADS_PREFIX}${branch}^{commit}`], {
      cwd: root,
      signal,
    })
    if (now.code === 0) layers.push({ branch, before: shortSha(sha), after: shortSha(now.stdout.trim()) })
  }
  return layers
}

/** The own remote branches of `branches` that their tips now no longer contain. */
async function forcePushRefs(root: string, branches: string[], signal?: AbortSignal): Promise<string[]> {
  const refs = new Set<string>()
  for (const branch of branches) {
    for (const own of await ownRemoteRefs(root, branch, signal)) {
      if (!(await isAncestor(root, `${REMOTE_REFS_PREFIX}${own.ref}`, `${HEADS_PREFIX}${branch}`, signal))) {
        refs.add(own.ref)
      }
    }
  }
  return [...refs]
}

/** How many of the commits `onto..top` have an autosquash subject. */
async function fixupsIn(root: string, onto: string, top: string, signal?: AbortSignal): Promise<number> {
  const out = await git(["log", "--format=%s", `${onto}..${HEADS_PREFIX}${top}`], { cwd: root, signal })
  return out.split("\n").filter((subject) => AUTOSQUASH_PATTERN.test(subject)).length
}

/**
 * What a rebase left after git returned, for both rebase tools: a rebase still
 * in progress is a paused result (conflicts, an empty commit, or another stop);
 * a run that failed with no rebase left did not happen and throws `git_error`;
 * otherwise it is done, or aborted for `aborting`.
 */
export async function rebaseOutcome(root: string, input: OutcomeInput, signal?: AbortSignal): Promise<RebaseOutcome> {
  const { run, top, before, onto, warnings } = input
  const base = {
    top,
    onto: onto ? { ref: onto.ref, sha: shortSha(onto.sha) } : null,
    layers: await layersNow(root, before, signal),
    warnings,
  }

  if ((await operationInProgress(root, signal)) === "rebase") {
    const output = tail(run)
    const files = await unmergedPaths(root, signal)
    const reason = files.length > 0 ? "conflicts" : saysEmpty(output) ? "empty" : "stopped"
    return {
      ...base,
      status: "paused",
      branch: null,
      folded: 0,
      needs_force_push: [],
      paused: {
        reason,
        stopped_on: await stoppedCommit(root, signal),
        conflicts: reason === "conflicts" ? await readConflictMap(root, undefined, signal) : null,
        ...(input.unresolved ? { unresolved: input.unresolved } : {}),
        output,
        next: nextStep(reason, input.unresolved !== undefined),
      },
    }
  }

  if (run.code !== 0) throw classifyGitFailure(["rebase"], run)
  if (input.aborting) {
    return { ...base, status: "aborted", branch: await currentBranch(root, signal), folded: 0, needs_force_push: [] }
  }

  const fixupsAfter = input.fixupsBefore === null || !onto ? null : await fixupsIn(root, onto.sha, top, signal)
  return {
    ...base,
    status: "done",
    branch: await currentBranch(root, signal),
    folded: input.fixupsBefore === null || fixupsAfter === null ? 0 : Math.max(0, input.fixupsBefore - fixupsAfter),
    needs_force_push: await forcePushRefs(
      root,
      base.layers.map((layer) => layer.branch),
      signal,
    ),
  }
}
