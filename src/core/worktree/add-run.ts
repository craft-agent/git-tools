import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { isToolError, ToolError } from "../errors"
import { git, gitResult } from "../git"
import { realpathOrSelf } from "../paths"
import { readRemote } from "../push/remote-read"
import { REMOTE_REFS_PREFIX } from "../rewrite"
import { hasOrigin, ORIGIN_REMOTE, type AddPlan, type AddRequest } from "./add-plan"
import type { AddedWorktree } from "./add-schema"
import { WORKTREE_ROOT_OPTION } from "./layout"

/** How long fetching `origin` may take before the base is taken as of the last fetch. */
const FETCH_TIMEOUT_MS = 60_000

/** The branches tried, after the ones the repository and the remote name, as `origin`'s default. */
const CONVENTIONAL_DEFAULTS = ["main", "master"]

const HEAD_REF = "HEAD"

type Base = NonNullable<AddedWorktree["base"]>

/** Fetches `origin`; false when the fetch failed or ran out of time. A cancellation still throws. */
async function fetchOrigin(root: string, signal?: AbortSignal): Promise<boolean> {
  try {
    await git(["fetch", "--quiet", ORIGIN_REMOTE], { cwd: root, signal, timeoutMs: FETCH_TIMEOUT_MS })
    return true
  } catch (error) {
    if (!isToolError(error)) throw error
    return false
  }
}

/** The full commit `ref` names here, or null when it names none. */
async function resolveCommit(root: string, ref: string, signal?: AbortSignal): Promise<string | null> {
  const result = await gitResult(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], { cwd: root, signal })
  return result.code === 0 ? result.stdout.trim() : null
}

/** The default branch this repository recorded for `origin` (`origin/main`), or null when it recorded none. */
async function recordedDefault(root: string, signal?: AbortSignal): Promise<string | null> {
  const head = await gitResult(["symbolic-ref", "--quiet", "--short", `${REMOTE_REFS_PREFIX}${ORIGIN_REMOTE}/HEAD`], {
    cwd: root,
    signal,
  })
  return head.code === 0 ? head.stdout.trim() || null : null
}

/** The default branch `origin` names now (`main`), or null when the remote cannot be read. */
async function liveDefault(root: string, signal?: AbortSignal): Promise<string | null> {
  try {
    return (await readRemote(root, ORIGIN_REMOTE, [], signal)).defaultBranch
  } catch (error) {
    if (!isToolError(error)) throw error
    return null
  }
}

/**
 * `origin`'s default branch as a local ref that resolves: the one recorded
 * here, else the one the remote names, else `origin/main`, else
 * `origin/master`; the first that resolves wins.
 */
async function originDefault(root: string, signal?: AbortSignal): Promise<Base | null> {
  const recorded = await recordedDefault(root, signal)
  const named = recorded === null ? await liveDefault(root, signal) : null
  const refs = [
    recorded,
    named === null ? null : `${ORIGIN_REMOTE}/${named}`,
    ...CONVENTIONAL_DEFAULTS.map((name) => `${ORIGIN_REMOTE}/${name}`),
  ]
  for (const ref of refs) {
    const sha = ref === null ? null : await resolveCommit(root, ref, signal)
    if (ref !== null && sha !== null) return { ref, sha }
  }
  return null
}

/**
 * Where a new branch starts: `from`, else `origin`'s default branch when
 * there is an `origin`, else the caller's `HEAD`.
 */
async function startingPoint(
  root: string,
  from: string | undefined,
  originExists: boolean,
  signal?: AbortSignal,
): Promise<Base> {
  if (from !== undefined) {
    const sha = await resolveCommit(root, from, signal)
    if (sha === null) {
      throw new ToolError(
        "not_found",
        `${from} is not a commit here; pass a branch, tag or commit id, or leave from out.`,
      )
    }
    return { ref: from, sha }
  }
  if (originExists) {
    const base = await originDefault(root, signal)
    if (base === null) {
      throw new ToolError("invalid_argument", `${ORIGIN_REMOTE}'s default branch is unknown here; pass from.`)
    }
    return base
  }
  const sha = await resolveCommit(root, HEAD_REF, signal)
  if (sha === null) {
    throw new ToolError(
      "invalid_argument",
      "HEAD has no commit yet, so there is nothing to cut the branch from; make a commit, or pass from.",
    )
  }
  return { ref: HEAD_REF, sha }
}

/** Creates the folders above the target, which `git worktree add` leaves to the caller beyond the last one. */
async function createParents(target: string): Promise<void> {
  const parent = dirname(target)
  try {
    await mkdir(parent, { recursive: true })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new ToolError(
      "invalid_argument",
      `Could not create ${parent}: ${reason}; check the ${WORKTREE_ROOT_OPTION} setting.`,
      {
        cause: error,
      },
    )
  }
}

/** Adds the worktree with `git worktree add <options>`, from the caller's root and with hooks off, and returns its real path. */
async function addAt(request: AddRequest, plan: AddPlan, options: string[]): Promise<string> {
  await createParents(plan.target)
  await git(["worktree", "add", ...options], { cwd: request.callerRoot, signal: request.signal, hooks: false })
  return realpathOrSelf(plan.target)
}

/** Checks out an existing branch as it is; nothing is fetched. */
export async function addExisting(request: AddRequest, plan: AddPlan): Promise<AddedWorktree> {
  const directory = await addAt(request, plan, [plan.target, plan.branch])
  return { directory, branch: plan.branch, new_branch: false, base: null, fetched: null, warnings: [] }
}

/** Cuts a new branch without an upstream, after fetching `origin` when there is one, and checks it out. */
export async function addNew(request: AddRequest, plan: AddPlan): Promise<AddedWorktree> {
  const { callerRoot, signal } = request
  const originExists = await hasOrigin(callerRoot, signal)
  const fetched = originExists ? await fetchOrigin(callerRoot, signal) : null
  const base = await startingPoint(callerRoot, plan.from, originExists, signal)
  const directory = await addAt(request, plan, ["--no-track", "-b", plan.branch, plan.target, base.sha])
  return {
    directory,
    branch: plan.branch,
    new_branch: true,
    base,
    fetched,
    warnings: fetched === false ? [`fetching ${ORIGIN_REMOTE} failed: ${base.ref} is as of the last fetch`] : [],
  }
}
