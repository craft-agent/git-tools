import { realpath } from "node:fs/promises"
import { z } from "zod"
import { ToolError } from "../errors"
import { AUTOSQUASH_PATTERN } from "../commit/message-rules"
import { git } from "../git"
import { realpathOrSelf } from "../paths"
import {
  checkRewrite,
  ownRemoteRefs,
  REMOTE_REFS_PREFIX,
  rewriteCheckSchema,
  shortSha,
  type RewriteCheck,
} from "../rewrite"
import { readStack, topBranch, type Stack, type StackLayer } from "../stack"
import { currentBranch, defaultBranchRef, isAncestor } from "../tree"
import { LOCAL_BRANCH_PREFIX, listWorktrees } from "../worktrees"

/** How many commits of a layer the read lists. */
const MAX_LAYER_COMMITS = 30

const REMOTE_STATES = ["same", "ahead", "behind", "diverged"] as const

const commitSchema = z.object({
  sha: z.string().describe("The short commit id."),
  subject: z.string().describe("The first line of the commit message."),
})

const remoteSchema = z.object({
  branch: z.string().describe("The local branch of the layer."),
  ref: z.string().describe("The branch's own remote branch, such as origin/feat."),
  state: z
    .enum(REMOTE_STATES)
    .describe(
      '"same": the local tip is the remote tip. "ahead": the local tip has commits the remote lacks, so a plain push is enough. "behind": the remote has commits the local tip lacks. "diverged": each has commits the other lacks, so pushing needs a force push.',
    ),
})

const layerSchema = z.object({
  branches: z.array(z.string()).describe("The local branches on the layer's tip; the checked-out branch comes first."),
  tip: z.string().describe("The short id of the layer's tip."),
  current: z.boolean().describe("True for the layer of the checked-out branch."),
  count: z.number().int().describe("How many commits the layer adds to the layer below, or to the base for the first."),
  commits: z.array(commitSchema).describe(`The layer's commits, oldest first; at most ${MAX_LAYER_COMMITS}.`),
  truncated: z.boolean().describe("True when the layer has more commits than are listed."),
  fixups: z.number().int().describe('How many of the layer\'s commits are "fixup! ", "squash! " or "amend! " commits.'),
  remotes: z.array(remoteSchema).describe("Each branch's own remote branches, and where the local tip stands to them."),
  worktree: z
    .string()
    .nullable()
    .describe("The path of another worktree where one of the layer's branches is checked out; null when none is."),
})

/** The stack of the checked-out branch, bottom to top. */
export const stackViewSchema = z.object({
  base: z.object({
    ref: z.string().describe("The remote default branch the stack grows from, such as origin/main."),
    sha: z.string().describe("The short id of the merge base the first layer starts at."),
  }),
  branch: z.string().describe("The checked-out branch."),
  top: z.string().describe("The branch the stack ends at."),
  layers: z.array(layerSchema).describe("The layers, bottom to top."),
  rewrite: rewriteCheckSchema
    .nullable()
    .describe(
      "Whether every layer may be rewritten, as a rebase of the whole stack would, and whether pushing then needs a force push; null when the stack has no commits.",
    ),
})

type Remote = z.output<typeof remoteSchema>

/** The commits `exclude..tip` adds, oldest first, as full ids with their subjects. */
async function layerCommits(root: string, exclude: string, tip: string, signal?: AbortSignal) {
  const out = await git(["log", "--reverse", "--topo-order", "--format=%H%x00%s", `${exclude}..${tip}`], {
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

/** Where `tip` stands to the remote branch `ref`. */
async function remoteState(root: string, tip: string, ref: string, signal?: AbortSignal): Promise<Remote["state"]> {
  const remoteRef = `${REMOTE_REFS_PREFIX}${ref}`
  const remoteTip = (await git(["rev-parse", `${remoteRef}^{commit}`], { cwd: root, signal })).trim()
  if (remoteTip === tip) return "same"
  if (await isAncestor(root, remoteRef, tip, signal)) return "ahead"
  return (await isAncestor(root, tip, remoteRef, signal)) ? "behind" : "diverged"
}

/** The worktrees other than `root` and the branch checked out in each, by full branch name. */
export async function otherWorktrees(root: string, signal?: AbortSignal): Promise<Map<string, string>> {
  const worktrees = await listWorktrees(root, signal)
  const self = await realpath(root)
  const checkedOut = new Map<string, string>()
  for (const { path, branch } of worktrees) {
    if (path && branch?.startsWith(LOCAL_BRANCH_PREFIX) && (await realpathOrSelf(path)) !== self) {
      checkedOut.set(branch.slice(LOCAL_BRANCH_PREFIX.length), path)
    }
  }
  return checkedOut
}

async function readLayer(
  root: string,
  stack: Stack,
  index: number,
  checkedOut: Map<string, string>,
  signal?: AbortSignal,
) {
  const layer: StackLayer = stack.layers[index]!
  const below = index === 0 ? stack.base : stack.layers[index - 1]!.tip
  const all = await layerCommits(root, below, layer.tip, signal)
  const remotes: Remote[] = []
  for (const branch of layer.branches) {
    for (const own of await ownRemoteRefs(root, branch, signal)) {
      remotes.push({ branch, ref: own.ref, state: await remoteState(root, layer.tip, own.ref, signal) })
    }
  }
  const view = {
    branches: layer.branches,
    tip: shortSha(layer.tip),
    current: index === stack.position,
    count: all.length,
    commits: all.slice(0, MAX_LAYER_COMMITS).map(({ sha, subject }) => ({ sha: shortSha(sha), subject })),
    truncated: all.length > MAX_LAYER_COMMITS,
    fixups: all.filter(({ subject }) => AUTOSQUASH_PATTERN.test(subject)).length,
    remotes,
    worktree: layer.branches.map((branch) => checkedOut.get(branch)).find((path) => path !== undefined) ?? null,
  }
  return { view, oldest: all[0]?.sha }
}

/**
 * Reads the stack of the checked-out branch: its layers with their commits, how
 * each branch stands to its remote branches, the other worktrees holding them,
 * and what the rewrite rule says about rebasing the whole stack. `top` names the
 * branch the stack ends at, for branches above that fork.
 */
export async function readStackView(
  root: string,
  top: string | undefined,
  signal?: AbortSignal,
): Promise<z.output<typeof stackViewSchema>> {
  if (!(await currentBranch(root, signal))) {
    throw new ToolError("invalid_argument", "HEAD is detached; check out a branch of the stack.")
  }
  const defaultRef = await defaultBranchRef(root, signal)
  if (!defaultRef) {
    throw new ToolError(
      "not_found",
      "The remote default branch is not known here (no origin/HEAD, origin/main or origin/master); run `git remote set-head origin --auto` first.",
    )
  }
  const stack = await readStack(root, { top, signal })
  if (!stack) {
    throw new ToolError("not_found", `HEAD shares no history with ${defaultRef}, so it is on no stack.`)
  }

  const checkedOut = await otherWorktrees(root, signal)
  const layers = []
  let oldest: string | undefined
  for (let index = 0; index < stack.layers.length; index++) {
    const read = await readLayer(root, stack, index, checkedOut, signal)
    layers.push(read.view)
    oldest ??= read.oldest
  }

  let rewrite: RewriteCheck | null = null
  if (oldest !== undefined) rewrite = await checkRewrite(root, oldest, { wholeStack: true, top, signal })
  return {
    base: { ref: stack.default_ref, sha: shortSha(stack.base) },
    branch: stack.branch,
    top: topBranch(stack),
    layers,
    rewrite,
  }
}
