import { ToolError } from "../errors"
import { gitResult } from "../git"
import { HEADS_REF, readStack } from "../stack"
import { currentBranch, defaultBranchRef } from "../tree"

/** The remote a branch is pushed to when git config names none. */
const DEFAULT_REMOTE = "origin"

/** The value of `branch.<name>.remote` that means the branch tracks a local branch, not a remote. */
const LOCAL_REMOTE = "."

/** What a branch is measured against to tell whether it has commits of its own. */
export type Below = { sha: string; name: string }

/** A branch a push is previewed for, with the commit it is at. */
export type SelectedBranch = {
  branch: string
  /** The full id of the branch's tip. */
  sha: string
  /** The commit the branch builds on in its line: the layer below, or the default branch. Null when none is known. */
  below: Below | null
  /** The first branch of the layer when this one shares its tip; null otherwise. */
  sameAs: string | null
}

type Selection = { top?: string; branches?: string[] }

async function defaultBelow(root: string, signal?: AbortSignal): Promise<Below | null> {
  const name = await defaultBranchRef(root, signal)
  if (!name) return null
  const resolved = await gitResult(["rev-parse", "--verify", "--quiet", `${name}^{commit}`], { cwd: root, signal })
  return resolved.code === 0 ? { sha: resolved.stdout.trim(), name } : null
}

/** The full id of the tip of the local branch `name`; `invalid_argument` for a name that cannot be one, `not_found` when there is none. */
export async function branchTip(root: string, name: string, signal?: AbortSignal): Promise<string> {
  if (name === "" || name.startsWith("-")) {
    throw new ToolError("invalid_argument", `"${name}" is not a branch name; name a local branch, not an option.`)
  }
  const found = await gitResult(
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${HEADS_REF}/${name}^{commit}`],
    {
      cwd: root,
      signal,
    },
  )
  if (found.code !== 0) {
    throw new ToolError("not_found", `${name} is not a local branch; check the name, or create the branch first.`)
  }
  return found.stdout.trim()
}

async function namedBranches(root: string, names: string[], signal?: AbortSignal): Promise<SelectedBranch[]> {
  const below = await defaultBelow(root, signal)
  const selected: SelectedBranch[] = []
  for (const name of new Set(names.map((raw) => raw.trim()))) {
    selected.push({ branch: name, sha: await branchTip(root, name, signal), below, sameAs: null })
  }
  return selected
}

/** The layer branches of the current line, bottom to top, or the current branch alone when no remote default branch is known. */
async function currentLine(root: string, top: string | undefined, signal?: AbortSignal): Promise<SelectedBranch[]> {
  const branch = await currentBranch(root, signal)
  if (!branch) throw new ToolError("invalid_argument", "HEAD is detached; check out a branch, or pass branches.")
  const stack = await readStack(root, { top, signal })
  if (!stack) {
    return [
      { branch, sha: await branchTip(root, branch, signal), below: await defaultBelow(root, signal), sameAs: null },
    ]
  }
  return stack.layers.flatMap((layer, index) => {
    const lower = stack.layers[index - 1]
    const below: Below = lower
      ? { sha: lower.tip, name: lower.branches[0]! }
      : { sha: stack.base, name: stack.default_ref }
    return layer.branches.map((name, position) => ({
      branch: name,
      sha: layer.tip,
      below,
      sameAs: position === 0 ? null : layer.branches[0]!,
    }))
  })
}

/**
 * The branches a push is previewed for: `branches` (each a local branch,
 * deduplicated, in the given order), else every branch of the current line,
 * bottom to top, as `readStack` reads it (`top` names the end of a forked
 * line). A line with no known remote default branch is the current branch
 * alone. `invalid_argument` for `top` with `branches`, a name that is an
 * option, a detached HEAD without `branches` and a forked line without `top`;
 * `not_found` for a branch that does not exist.
 */
export async function selectBranches(
  root: string,
  selection: Selection,
  signal?: AbortSignal,
): Promise<SelectedBranch[]> {
  if (selection.branches === undefined) return currentLine(root, selection.top, signal)
  if (selection.top !== undefined) {
    throw new ToolError(
      "invalid_argument",
      "top names the end of the current line, so it does not go with branches; leave one out.",
    )
  }
  return namedBranches(root, selection.branches, signal)
}

/** The remote git pushes `branch` to: its push remote, the default push remote, the remote it tracks, else `origin`. */
async function pushRemoteOf(root: string, branch: string, signal?: AbortSignal): Promise<string> {
  const keys = [`branch.${branch}.pushRemote`, "remote.pushDefault", `branch.${branch}.remote`]
  for (const key of keys) {
    const read = await gitResult(["config", "--get", key], { cwd: root, signal })
    const value = read.code === 0 ? read.stdout.trim() : ""
    if (value && !(key.endsWith(".remote") && value === LOCAL_REMOTE)) return value
  }
  return DEFAULT_REMOTE
}

/**
 * The remote the branches are pushed to: `remote`, else the one git pushes
 * them to. Branches that go to different remotes are `invalid_argument`
 * naming them, as is a name that is an option; a remote this repository does
 * not have is `not_found`.
 */
export async function resolveRemote(
  root: string,
  branches: string[],
  remote: string | undefined,
  signal?: AbortSignal,
): Promise<string> {
  let name = remote
  if (name === undefined) {
    const byRemote = new Map<string, string[]>()
    for (const branch of branches) {
      const target = await pushRemoteOf(root, branch, signal)
      byRemote.set(target, [...(byRemote.get(target) ?? []), branch])
    }
    if (byRemote.size > 1) {
      const split = [...byRemote].map(([target, names]) => `${target}: ${names.join(", ")}`).join("; ")
      throw new ToolError(
        "invalid_argument",
        `These branches are pushed to different remotes (${split}); pass remote to name the one to push to.`,
      )
    }
    name = [...byRemote.keys()][0]!
  }
  if (name.startsWith("-")) {
    throw new ToolError("invalid_argument", `"${name}" is not a remote name; name a remote, not an option.`)
  }
  const url = await gitResult(["remote", "get-url", name], { cwd: root, signal })
  if (url.code !== 0) {
    throw new ToolError("not_found", `${name} is not a remote of this repository; add it, or pass remote.`)
  }
  return name
}
