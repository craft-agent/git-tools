import { AUTOSQUASH_PATTERN } from "../commit/message-rules"
import { ToolError } from "../errors"
import { git, gitResult, requireGitVersion } from "../git"
import { checkRewrite, currentBranch, isAncestor, resolveCommit, type RewriteCheck } from "../rewrite"
import { readStack, stackBranches, topBranch, type Stack } from "../stack"
import { defaultBranchRef, operationInProgress } from "../tree"
import type { LayerTip } from "./rebase-state"
import { otherWorktrees } from "./stack-read"

/** The oldest git with `rebase --update-refs`, which moves every layer branch of a stack together. */
const UPDATE_REFS_GIT_VERSION = "2.38.0"

/** The arguments of `git_rebase_start`. */
export type StartArgs = { onto?: string; keep_base?: boolean; after?: string; top?: string }

/** A commit of the range a rebase replays. */
export type RangeCommit = { sha: string; subject: string }

/** What a call of `git_rebase_start` will do, worked out from the repository without writing to it. */
export type StartPlan = {
  /** The branch checked out when the call was made; the rebase returns to it. */
  startBranch: string
  /** The branch the rebase runs on: the stack's top. */
  top: string
  /** The full id of the top's tip. */
  topTip: string
  /** The branches the rebase moves, bottom to top, with their tips; the top is always among them. */
  moved: LayerTip[]
  /** The ref the rebase goes onto as it was named; null for `keep_base`. */
  ontoRef: string | null
  /** The full id of the commit the rebase goes onto. */
  ontoSha: string
  /** The full id the replayed range starts after: the tip of `after`, else where the top forks from the onto commit. */
  upstream: string
  /** The `after` branch, when given. */
  after: string | undefined
  /** The commits replayed, oldest first. */
  range: RangeCommit[]
  /** How many commits of the range are fixup!, squash! or amend! commits. */
  fixups: number
  /** True when there is nothing to rebase or fold. */
  upToDate: boolean
  /** The rewrite rule's verdict on the range; null when nothing is rewritten. */
  rule: RewriteCheck | null
  /** Whether `--update-refs` is needed to move more than one branch. */
  updateRefs: boolean
  warnings: string[]
}

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** Throws unless the checks that come before anything is read pass: the arguments, an attached HEAD, no operation, no tracked changes. */
async function requireStartable(root: string, args: StartArgs, signal?: AbortSignal): Promise<string> {
  if (args.onto?.startsWith("-")) throw invalid("onto must name a commit or a ref, not an option.")
  if (args.keep_base && (args.onto !== undefined || args.after !== undefined)) {
    throw invalid("keep_base folds the fixups on the current base, so it takes neither onto nor after.")
  }
  // Before the detached check: a rebase in progress leaves HEAD detached, and that is not the reason to name.
  const operation = await operationInProgress(root, signal)
  if (operation) {
    throw new ToolError("operation_in_progress", `A ${operation} is in progress; finish or abort it first.`)
  }
  const branch = await currentBranch(root, signal)
  if (!branch) throw invalid("HEAD is detached; check out a branch of the stack.")
  const tracked = await git(["status", "--porcelain", "--untracked-files=no"], { cwd: root, signal })
  if (tracked.trim() !== "") {
    throw new ToolError("dirty_tree", "There are uncommitted changes; commit or stash them before rebasing.")
  }
  return branch
}

/** Fetches the remote default branch; a failure is a warning, and the existing remote branch is used. */
async function fetchDefault(root: string, signal?: AbortSignal): Promise<string[]> {
  const defaultRef = await defaultBranchRef(root, signal)
  if (!defaultRef) return []
  const slash = defaultRef.indexOf("/")
  const fetched = await gitResult(["fetch", defaultRef.slice(0, slash), defaultRef.slice(slash + 1)], {
    cwd: root,
    signal,
  })
  return fetched.code === 0
    ? []
    : [
        `Could not fetch ${defaultRef} (${fetched.stderr.trim() || `exit ${fetched.code}`}); rebasing onto it as of the last fetch.`,
      ]
}

/** The index of the layer `after` names, which must lie below the top. */
function afterLayerIndex(stack: Stack, after: string): number {
  const index = stack.layers.findIndex((layer) => layer.branches.includes(after))
  if (index < 0 || index === stack.layers.length - 1) {
    throw invalid(
      `after must name a layer branch below the top of the stack, and ${after} is not one; the layer branches are ${stackBranches(stack).join(", ")}.`,
    )
  }
  return index
}

/** Refuses a moved branch that another worktree has checked out, which git would leave behind. */
async function requireNotCheckedOut(root: string, branches: string[], signal?: AbortSignal): Promise<void> {
  const checkedOut = await otherWorktrees(root, signal)
  for (const branch of branches) {
    const path = checkedOut.get(branch)
    if (path !== undefined) {
      throw invalid(
        `${branch} is checked out in another worktree (${path}), so the rebase would leave it on the old commits; check out another branch there first.`,
      )
    }
  }
}

async function replayedRange(
  root: string,
  upstream: string,
  tip: string,
  signal?: AbortSignal,
): Promise<RangeCommit[]> {
  const out = await git(["log", "--reverse", "--topo-order", "--format=%H%x00%s", `${upstream}..${tip}`], {
    cwd: root,
    signal,
  })
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", subject = ""] = line.split("\0")
      return { sha, subject }
    })
}

/**
 * Checks the call and works out what it would do: the stack, what it goes onto
 * and replays, and whether the rewrite rule allows it. It writes nothing; with
 * `fetch` it first fetches the remote default branch, for a call that names no
 * `onto`. A call that would fail throws the error it would fail with, so a
 * description made from the plan exists only for a call that can run.
 */
export async function planRebase(
  root: string,
  given: StartArgs,
  options: { fetch: boolean; signal?: AbortSignal },
): Promise<StartPlan> {
  const { signal } = options
  const args: StartArgs = {
    ...given,
    onto: given.onto?.trim() || undefined,
    after: given.after?.trim() || undefined,
    top: given.top?.trim() || undefined,
  }
  const startBranch = await requireStartable(root, args, signal)
  const keepBase = args.keep_base === true
  const warnings = options.fetch && args.onto === undefined && !keepBase ? await fetchDefault(root, signal) : []

  const stack = await readStack(root, { top: args.top, signal })
  if (!stack) {
    throw new ToolError(
      "not_found",
      "No stack can be read: the remote default branch is not known here (no origin/HEAD, origin/main or origin/master; run `git remote set-head origin --auto`), or HEAD shares no history with it.",
    )
  }
  const topLayer = stack.layers[stack.layers.length - 1]!
  const top = args.top !== undefined && topLayer.branches.includes(args.top) ? args.top : topBranch(stack)
  const afterIndex = args.after === undefined ? -1 : afterLayerIndex(stack, args.after)

  const ontoRef = keepBase ? null : (args.onto ?? stack.default_ref)
  const ontoSha = ontoRef === null ? stack.base : await resolveCommit(root, ontoRef, signal)
  const forkPoint = await gitResult(["merge-base", topLayer.tip, ontoSha], { cwd: root, signal })
  if (forkPoint.code !== 0) throw invalid(`${top} shares no history with ${ontoRef ?? ontoSha}.`)
  const mergeBase = forkPoint.stdout.trim()
  const upstream = afterIndex < 0 ? mergeBase : stack.layers[afterIndex]!.tip

  const range = await replayedRange(root, upstream, topLayer.tip, signal)
  const fixups = range.filter(({ subject }) => AUTOSQUASH_PATTERN.test(subject)).length
  const upToDate = fixups === 0 && (keepBase || (mergeBase === ontoSha && upstream === mergeBase))

  const moved: LayerTip[] = []
  for (const layer of stack.layers.slice(afterIndex + 1)) {
    if (await isAncestor(root, layer.tip, upstream, signal)) continue
    moved.push(...layer.branches.map((branch) => ({ branch, sha: layer.tip })))
  }
  if (!moved.some((tip) => tip.branch === top)) moved.push({ branch: top, sha: topLayer.tip })

  const onDefault = startBranch === stack.default_ref.slice(stack.default_ref.indexOf("/") + 1)
  const oldest = range[0]?.sha ?? (onDefault ? stack.layers[stack.position]!.tip : undefined)
  let rule: RewriteCheck | null = null
  if (oldest !== undefined && (!upToDate || onDefault)) {
    rule = await checkRewrite(root, oldest, { wholeStack: true, top: args.top, base: upstream, signal })
    if (!rule.allowed) {
      throw new ToolError("rewrite_refused", rule.refusals.map((refusal) => refusal.message).join(" "), {
        details: { refusals: rule.refusals, warnings: rule.warnings },
      })
    }
    warnings.push(...rule.warnings)
  }

  const updateRefs = moved.length > 1
  if (updateRefs && !upToDate) {
    await requireGitVersion(UPDATE_REFS_GIT_VERSION, "moving every branch of a stack (--update-refs)", signal)
  }
  if (!upToDate)
    await requireNotCheckedOut(
      root,
      moved.map((tip) => tip.branch),
      signal,
    )

  return {
    startBranch,
    top,
    topTip: topLayer.tip,
    moved,
    ontoRef,
    ontoSha,
    upstream,
    after: args.after,
    range,
    fixups,
    upToDate,
    rule,
    updateRefs,
    warnings,
  }
}
