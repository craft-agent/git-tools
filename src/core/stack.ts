/**
 * What a stack of layer branches is, read from ancestry alone: the current
 * branch's line, the local branches between the remote default branch and the
 * top. Nothing is recorded anywhere, so a stack made by any tool, or by hand,
 * reads the same.
 */

import { ToolError } from "./errors"
import { git, gitResult } from "./git"
import { currentBranch, defaultBranchRef, isAncestor } from "./tree"

/** Where git keeps the local branches. */
export const HEADS_REF = "refs/heads"

/** One layer of a stack: the branches that share one tip. */
export type StackLayer = {
  /** Sorted by name, the current branch first. */
  branches: string[]
  /** The full id of the commit every branch of the layer points at. */
  tip: string
}

/** The stack the checked-out branch belongs to. */
export type Stack = {
  /** The full id of the merge base of HEAD and the remote default branch. */
  base: string
  /** The remote default branch the stack grows from, such as `origin/main`. */
  default_ref: string
  /** The checked-out branch. */
  branch: string
  /** The index in `layers` of the checked-out branch's layer. */
  position: number
  /** The layers bottom to top; always holds the checked-out branch's layer. */
  layers: StackLayer[]
}

type BranchTip = { branch: string; sha: string }

/** The local branches `filters` (for-each-ref options) select, with their tips. */
async function localBranches(root: string, filters: string[], signal?: AbortSignal): Promise<BranchTip[]> {
  const out = await git(["for-each-ref", "--format=%(objectname) %(refname)", ...filters, HEADS_REF], {
    cwd: root,
    signal,
  })
  return out
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [sha = "", ref = ""] = line.split(" ")
      return { branch: ref.slice(`${HEADS_REF}/`.length), sha }
    })
}

/** Groups branches by tip, each group sorted by name. */
function layersOf(tips: BranchTip[]): StackLayer[] {
  const byTip = new Map<string, string[]>()
  for (const { branch, sha } of tips) byTip.set(sha, [...(byTip.get(sha) ?? []), branch])
  return [...byTip].map(([tip, branches]) => ({ branches: branches.sort(), tip }))
}

/** The position of each commit in `git rev-list --reverse --topo-order <args>`: parents before children. */
async function commitOrder(root: string, args: string[], signal?: AbortSignal): Promise<Map<string, number>> {
  const out = await git(["rev-list", "--reverse", "--topo-order", ...args], { cwd: root, signal })
  return new Map(
    out
      .split("\n")
      .filter(Boolean)
      .map((sha, index) => [sha, index]),
  )
}

/** The layers a stack has between the default branch and HEAD, bottom to top. */
async function layersBelow(root: string, base: string, tips: BranchTip[], signal?: AbortSignal): Promise<StackLayer[]> {
  const layers = layersOf(tips)
  if (layers.length === 0) return layers
  const order = await commitOrder(root, ["HEAD", "--not", base], signal)
  const position = (layer: StackLayer): number => order.get(layer.tip) ?? Number.MAX_SAFE_INTEGER
  return layers.sort((a, b) => position(a) - position(b))
}

/** The layers above HEAD's that stay in the line ending at `top`, or the whole line when none is named. */
async function layersAboveHead(
  root: string,
  branch: string,
  lineBelow: string[],
  tips: BranchTip[],
  top: string | undefined,
  signal?: AbortSignal,
): Promise<StackLayer[]> {
  if (top !== undefined && top !== branch && !tips.some((tip) => tip.branch === top)) {
    throw new ToolError(
      "invalid_argument",
      `${top} is neither ${branch} nor a branch above it; name the branch the stack ends at.`,
    )
  }
  if (top === branch) return []

  const layers = layersOf(tips)
  if (layers.length === 0) return layers
  const order = await commitOrder(root, [...layers.map((layer) => layer.tip), "--not", "HEAD"], signal)
  layers.sort((a, b) => order.get(a.tip)! - order.get(b.tip)!)

  if (top !== undefined) {
    const topTip = layers.find((layer) => layer.branches.includes(top))!.tip
    const kept: StackLayer[] = []
    for (const layer of layers) {
      if (layer.tip === topTip || (await isAncestor(root, layer.tip, topTip, signal))) kept.push(layer)
    }
    return kept
  }

  for (let i = 1; i < layers.length; i++) {
    if (!(await isAncestor(root, layers[i - 1]!.tip, layers[i]!.tip, signal))) {
      throw await forkError(root, branch, lineBelow, layers, signal)
    }
  }
  return layers
}

/** What the `invalid_argument` for a fork above the current branch carries in `details`. */
export type ForkDetails = {
  /** The branches the stack may end at, sorted. */
  candidate_tops: string[]
  /** Every local branch on the line, sorted: below, the current layer, and all branches above of every fork. */
  line_branches: string[]
}

/** The details of the error `readStack` throws for a fork above the current branch; null for any other error. */
export function forkDetails(error: ToolError): ForkDetails | null {
  const { candidate_tops, line_branches } = error.details ?? {}
  return Array.isArray(candidate_tops) && Array.isArray(line_branches)
    ? { candidate_tops: candidate_tops as string[], line_branches: line_branches as string[] }
    : null
}

/** The `invalid_argument` for a line that forks above the current branch, naming the candidate tops. */
async function forkError(
  root: string,
  branch: string,
  below: string[],
  layers: StackLayer[],
  signal?: AbortSignal,
): Promise<ToolError> {
  const tops: string[] = []
  for (const layer of layers) {
    let covered = false
    for (const other of layers) {
      if (other !== layer && (await isAncestor(root, layer.tip, other.tip, signal))) {
        covered = true
        break
      }
    }
    if (!covered) tops.push(...layer.branches)
  }
  tops.sort()
  return new ToolError(
    "invalid_argument",
    `The branches above ${branch} fork, so which line is the stack is ambiguous; the candidate tops are ${tops.join(", ")}. Pass top with the one the stack ends at.`,
    {
      details: {
        candidate_tops: tops,
        line_branches: [...below, ...layers.flatMap((layer) => layer.branches)].sort(),
      } satisfies ForkDetails,
    },
  )
}

/**
 * Reads the stack the checked-out branch belongs to from ancestry: the local
 * branches whose tips lie between the remote default branch and the top, below
 * the current layer, sharing its tip, or above it, grouped by tip into layers
 * and ordered bottom to top. The local default branch never counts. Null when
 * HEAD is detached, no remote default branch is known, or HEAD shares no
 * history with it.
 *
 * Where the branches above fork, the stack is ambiguous: with `top` (the
 * current branch, a branch on its tip, or a branch above it) the layers that are ancestors of its tip
 * are kept; without it this throws `invalid_argument` naming the candidate
 * tops and, in `details` (see `ForkDetails`), every branch on the line. A `top` that is neither throws `invalid_argument` too.
 */
export async function readStack(
  root: string,
  options: { top?: string; signal?: AbortSignal } = {},
): Promise<Stack | null> {
  const { top, signal } = options
  const branch = await currentBranch(root, signal)
  if (!branch) return null
  const defaultRef = await defaultBranchRef(root, signal)
  if (!defaultRef) return null
  const mergeBase = await gitResult(["merge-base", "HEAD", defaultRef], { cwd: root, signal })
  if (mergeBase.code !== 0) return null

  const base = mergeBase.stdout.trim()
  const head = (await git(["rev-parse", "HEAD"], { cwd: root, signal })).trim()
  const defaultBranch = defaultRef.slice(defaultRef.indexOf("/") + 1)
  const others = (tips: BranchTip[]) => tips.filter((tip) => tip.branch !== branch && tip.branch !== defaultBranch)

  // A HEAD the default branch holds is on no stack: whatever descends from it is not a layer.
  const onDefault = head === base
  const below = onDefault
    ? []
    : others(await localBranches(root, ["--merged", "HEAD", "--no-merged", base], signal)).filter(
        (tip) => tip.sha !== head,
      )
  const containing = onDefault ? [] : others(await localBranches(root, ["--contains", "HEAD"], signal))

  const sharing = containing.filter((tip) => tip.sha === head).map((tip) => tip.branch)
  const current: StackLayer = { branches: [branch, ...sharing.sort()], tip: head }
  const layersBeneath = await layersBelow(root, base, below, signal)
  const layersOver = await layersAboveHead(
    root,
    branch,
    [...layersBeneath, current].flatMap((layer) => layer.branches),
    containing.filter((tip) => tip.sha !== head),
    top !== undefined && current.branches.includes(top) ? branch : top,
    signal,
  )
  return {
    base,
    default_ref: defaultRef,
    branch,
    position: layersBeneath.length,
    layers: [...layersBeneath, current, ...layersOver],
  }
}

/** The layers above the checked-out branch's, bottom to top. */
export function layersAbove(stack: Stack): StackLayer[] {
  return stack.layers.slice(stack.position + 1)
}

/** Every branch of every layer. */
export function stackBranches(stack: Stack): string[] {
  return stack.layers.flatMap((layer) => layer.branches)
}

/** The stack's top branch: the first branch of the last layer. */
export function topBranch(stack: Stack): string {
  return stack.layers[stack.layers.length - 1]!.branches[0]!
}
