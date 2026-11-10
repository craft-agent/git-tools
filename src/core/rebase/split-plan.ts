import { isToolError, ToolError } from "../errors"
import { git, gitResult } from "../git"
import { REMOTE_REFS_PREFIX, resolveCommit } from "../rewrite"
import { forkDetails, layersAbove, readStack, topBranch, type Stack } from "../stack"
import { currentBranch, operationInProgress } from "../tree"
import type { RangeCommit } from "./start-plan"

/** The arguments of `git_rebase_split`. */
export type SplitArgs = { at?: string[]; names?: string[]; add?: string }

/** A new lower layer: its branch name, the full id of its last commit and that commit's subject. */
export type SplitCut = { name: string; sha: string; subject: string }

/** What a call of `git_rebase_split` will do, worked out from the repository without writing to it. */
export type SplitPlan = {
  /** The checked-out branch; it stays the top of what it held. */
  branch: string
  /** The full id of HEAD. */
  head: string
  /** The new lower layers, bottom to top. */
  cuts: SplitCut[]
  /** The new empty layer to start on top, when given. */
  add: string | undefined
  /** The current layer's own commits, oldest first. */
  commits: RangeCommit[]
}

function invalid(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** Reads the stack of the checked-out branch; `null` stands for no remote default branch, which the callers turn into `not_found`. */
async function stackOrThrow(root: string, top: string | undefined, signal?: AbortSignal): Promise<Stack> {
  const stack = await readStack(root, { top, signal })
  if (!stack) {
    throw new ToolError(
      "not_found",
      "No stack can be read: the remote default branch is not known here (no origin/HEAD, origin/main or origin/master; run `git remote set-head origin --auto`), or HEAD shares no history with it.",
    )
  }
  return stack
}

/**
 * Reads the stack the branch belongs to. Cutting below the branch does not care
 * about layers that fork above it, so unless `needsTop` they are left out;
 * a call that adds a layer must know the one top, and a fork is refused.
 */
export async function readSplitStack(
  root: string,
  branch: string,
  needsTop: boolean,
  signal?: AbortSignal,
): Promise<Stack> {
  try {
    return await stackOrThrow(root, undefined, signal)
  } catch (error) {
    if (!isToolError(error) || forkDetails(error) === null) throw error
    if (!needsTop) return stackOrThrow(root, branch, signal)
    const { candidate_tops } = forkDetails(error)!
    throw invalid(
      `The branches above ${branch} fork, so there is no single top to add a layer on; check out the top you mean first (${candidate_tops.join(", ")}).`,
    )
  }
}

/** The full id the layer at `index` is counted from: the tip of the layer below, or the stack's base for the first. */
export function layerFloor(stack: Stack, index: number): string {
  return index === 0 ? stack.base : stack.layers[index - 1]!.tip
}

/** Every branch name a call would create: one per cut, then the added layer. */
export function newBranchNames(names: string[], add: string | undefined): string[] {
  return add === undefined ? names : [...names, add]
}

/** The commits `below..HEAD` adds, oldest first, with the number of parents of each. */
async function ownCommits(root: string, below: string, signal?: AbortSignal) {
  const out = await git(["log", "--reverse", "--topo-order", "--format=%H%x00%P%x00%s", `${below}..HEAD`], {
    cwd: root,
    signal,
  })
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", parents = "", subject = ""] = line.split("\0")
      return { sha, subject, parents: parents.split(" ").filter(Boolean).length }
    })
}

/** The remotes the clone knows. */
async function remoteNames(root: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(["remote"], { cwd: root, signal })
  return out
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
}

/** Whether the ref `ref` exists. */
async function refExists(root: string, ref: string, signal?: AbortSignal): Promise<boolean> {
  const found = await gitResult(["rev-parse", "--verify", "--quiet", ref], { cwd: root, signal })
  return found.code === 0
}

/** Throws unless `name` can be a new local branch no remote branch of the same name stands behind. */
async function requireNewBranch(root: string, name: string, remotes: string[], signal?: AbortSignal): Promise<void> {
  if (name === "") throw invalid("A branch name is empty.")
  if (name.startsWith("-")) throw invalid(`${name} is an option, not a branch name.`)
  const checked = await gitResult(["check-ref-format", "--branch", name], { cwd: root, signal })
  if (checked.code !== 0 || checked.stdout.trim() !== name) throw invalid(`${name} is not a valid branch name.`)
  if (await refExists(root, `refs/heads/${name}`, signal)) throw invalid(`The branch ${name} already exists.`)
  for (const remote of remotes) {
    if (await refExists(root, `${REMOTE_REFS_PREFIX}${remote}/${name}`, signal)) {
      throw invalid(`A branch ${name} exists on ${remote}; name a branch that is new there too.`)
    }
  }
}

/** Throws unless the arguments alone describe a call: something to do, one name per cut, names that differ. */
function requireArguments(at: string[], names: string[], add: string | undefined, branch: string): void {
  if (at.length === 0 && add === undefined) throw invalid("Give at (the commits to cut after) or add (a new layer).")
  if (at.length !== names.length) {
    throw invalid(`at lists ${at.length} commits and names ${names.length} names; give one name per commit.`)
  }
  const seen = new Set([branch])
  for (const name of newBranchNames(names, add)) {
    if (seen.has(name)) {
      throw invalid(name === branch ? `${name} is the current branch.` : `The name ${name} is used twice.`)
    }
    seen.add(name)
  }
}

/** Resolves the cuts against the current layer's commits: each one of them, below the tip, each above the one before. */
async function resolveCuts(
  root: string,
  at: string[],
  names: string[],
  commits: RangeCommit[],
  head: string,
  signal?: AbortSignal,
): Promise<SplitCut[]> {
  const cuts: SplitCut[] = []
  let previous = -1
  for (const [index, ref] of at.entries()) {
    if (ref.startsWith("-")) throw invalid(`${ref} is an option; at must name commits.`)
    const sha = await resolveCommit(root, ref, signal)
    if (sha === head) {
      throw invalid(`${ref} is the tip of the branch, which stays the top layer; cut at an earlier commit.`)
    }
    const position = commits.findIndex((commit) => commit.sha === sha)
    if (position < 0)
      throw invalid(`${ref} is not one of the commits of the current layer (the ones not on the layer below).`)
    if (position <= previous)
      throw invalid(`at must list the commits bottom up, and ${ref} is not above the one before it.`)
    previous = position
    cuts.push({ name: names[index]!, sha, subject: commits[position]!.subject })
  }
  return cuts
}

/**
 * Checks the call and works out what it would do: the current layer's commits,
 * where each cut lands and the names it takes. It writes nothing. A call that
 * would fail throws the error it would fail with, so a description made from
 * the plan exists only for a call that can run.
 */
export async function planSplit(root: string, given: SplitArgs, signal?: AbortSignal): Promise<SplitPlan> {
  const at = (given.at ?? []).map((ref) => ref.trim())
  const names = (given.names ?? []).map((name) => name.trim())
  const add = given.add?.trim()

  const operation = await operationInProgress(root, signal)
  if (operation) {
    throw new ToolError("operation_in_progress", `A ${operation} is in progress; finish or abort it first.`)
  }
  const branch = await currentBranch(root, signal)
  if (!branch) throw invalid("HEAD is detached; check out the branch to cut.")
  requireArguments(at, names, add, branch)

  const stack = await readSplitStack(root, branch, add !== undefined, signal)
  const defaultBranch = stack.default_ref.slice(stack.default_ref.indexOf("/") + 1)
  if (branch === defaultBranch) {
    throw invalid(`${branch} is the default branch and holds no commits of its own; check out a task branch first.`)
  }
  if (add !== undefined && layersAbove(stack).length > 0) {
    throw invalid(`${branch} has layers above it; a new layer goes on top, so check out ${topBranch(stack)} first.`)
  }

  const head = stack.layers[stack.position]!.tip
  const own = await ownCommits(root, layerFloor(stack, stack.position), signal)
  if (at.length > 0 && own.some((commit) => commit.parents > 1)) {
    throw invalid(`${branch} holds a merge commit among its own commits; cutting across a merge is not supported.`)
  }
  const commits = own.map(({ sha, subject }) => ({ sha, subject }))
  const cuts = await resolveCuts(root, at, names, commits, head, signal)

  const remotes = await remoteNames(root, signal)
  for (const name of newBranchNames(names, add)) await requireNewBranch(root, name, remotes, signal)
  return { branch, head, cuts, add, commits }
}
