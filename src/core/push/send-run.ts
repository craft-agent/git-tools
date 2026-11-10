import { isExecutableFile, lastLines } from "../commit/commit-run"
import { isToolError, ToolError } from "../errors"
import type { ExecResult } from "../exec"
import { gitResult } from "../git"
import { HEADS_REF } from "../stack"
import { gitPath } from "../tree"
import { readRemote } from "./remote-read"
import type { PreviewBranch } from "./schema"
import type { SendRequest } from "./send-plan"

/** A push runs the repository's pre-push hook and talks to the remote, which can be slow. */
const PUSH_TIMEOUT_MS = 300_000

/** The hook that can stop a push. */
const PRE_PUSH_HOOK = "pre-push"

/** The flag `git push --porcelain` gives a ref it rejected. */
const REJECTED_FLAG = "!"

/** The reasons, in `--porcelain` summaries, that the remote branch is not where the push expected it. */
const MOVED_REASONS = ["stale info", "fetch first", "non-fast-forward"]

/** One ref line of `git push --porcelain`: `<flag>\t<from>:<to>\t<summary>`. */
type RefStatus = { flag: string; to: string; summary: string }

/** The ref lines of `git push --porcelain` output; the `To <url>` and `Done` lines hold no tab and are left out. */
function parseRefStatuses(stdout: string): RefStatus[] {
  return stdout.split("\n").flatMap((line) => {
    const [flag, refs, summary = ""] = line.split("\t")
    if (flag?.length !== 1 || refs === undefined) return []
    return [{ flag, to: refs.slice(refs.indexOf(":") + 1), summary }]
  })
}

function outputOf(result: Pick<ExecResult, "stdout" | "stderr">): string {
  return lastLines(`${result.stdout}\n${result.stderr}`)
}

/** Whether a pre-push hook would run here, wherever `core.hooksPath` puts the hooks. */
async function hasPrePushHook(root: string): Promise<boolean> {
  return isExecutableFile(await gitPath(root, `hooks/${PRE_PUSH_HOOK}`))
}

/**
 * The error of a push that failed, nothing having been pushed (it is atomic):
 * `stale` when the remote moved under a lease, `check_failed` when the pre-push
 * hook stopped it (git exits 1 and names no ref, since the hook runs before
 * any ref is sent), else `git_error` with the tail of the output.
 */
async function pushFailure(root: string, result: ExecResult): Promise<ToolError> {
  const statuses = parseRefStatuses(result.stdout)
  const rejected = statuses.filter((status) => status.flag === REJECTED_FLAG)
  const moved = rejected.filter((status) => MOVED_REASONS.some((reason) => status.summary.includes(`(${reason})`)))
  if (moved.length > 0) {
    const refs = moved.map((status) => status.to.slice(HEADS_REF.length + 1)).join(", ")
    return new ToolError("stale", `The remote moved under the push (${refs}); nothing was pushed. Preview again.`, {
      details: { rejected: rejected.map(({ to, summary }) => ({ ref: to, summary })) },
    })
  }
  const output = outputOf(result)
  if (statuses.length === 0 && result.code === 1 && (await hasPrePushHook(root))) {
    return new ToolError(
      "check_failed",
      "The pre-push hook stopped the push; fix what its output in details reports and push again.",
      { details: { check: "hook", hooks: [PRE_PUSH_HOOK], exit_code: result.code, output } },
    )
  }
  return new ToolError("git_error", `git push failed (exit ${result.code})${output ? `: ${output}` : "."}`)
}

/**
 * Pushes exactly the request in one atomic push, each branch leased on its
 * `expect` (none for a new branch), hooks as configured. Returns the tail of
 * git's output; throws when nothing was pushed.
 */
export async function runPush(root: string, request: SendRequest, signal?: AbortSignal): Promise<string> {
  const { remote, branches } = request
  const args = [
    "push",
    "--atomic",
    "--porcelain",
    "--no-follow-tags",
    "--recurse-submodules=no",
    ...branches.map(({ branch, expect }) => `--force-with-lease=${HEADS_REF}/${branch}:${expect ?? ""}`),
    remote,
    ...branches.map(({ branch, sha }) => `${sha}:${HEADS_REF}/${branch}`),
  ]
  const result = await gitResult(args, { cwd: root, signal, timeoutMs: PUSH_TIMEOUT_MS })
  if (result.code !== 0) throw await pushFailure(root, result)
  return outputOf(result)
}

/** Sets the upstream of a branch just created on the remote when it has none; a failure is a warning, since the push happened. */
async function setUpstream(root: string, remote: string, branch: string): Promise<string | undefined> {
  const configured = await gitResult(["config", "--get", `branch.${branch}.merge`], { cwd: root })
  if (configured.code === 0) return undefined
  const set = await gitResult(["branch", `--set-upstream-to=${remote}/${branch}`, branch], { cwd: root })
  if (set.code === 0) return undefined
  return `Could not set the upstream of ${branch} to ${remote}/${branch}: ${set.stderr.trim() || `exit ${set.code}`}`
}

/** What the remote holds of the branches pushed, and the warnings of the steps after the push. */
export type AfterPush = { pushed: Map<string, boolean>; warnings: string[] }

/**
 * What follows a successful push: the upstream of each created branch that has
 * none, and a fresh read of the remote to tell which branches it now holds at
 * the pushed commit. The push has happened, so nothing here is cancelled and a
 * failure is a warning: a remote that cannot be read again leaves every branch
 * counted as pushed, which an atomic push that succeeded means.
 */
export async function afterPush(root: string, request: SendRequest, previewed: PreviewBranch[]): Promise<AfterPush> {
  const warnings: string[] = []
  for (const { branch, kind } of previewed) {
    if (kind !== "create") continue
    const warning = await setUpstream(root, request.remote, branch)
    if (warning) warnings.push(warning)
  }

  const names = request.branches.map(({ branch }) => branch)
  try {
    const live = await readRemote(root, request.remote, names)
    return {
      pushed: new Map(request.branches.map(({ branch, sha }) => [branch, live.heads.get(branch) === sha])),
      warnings,
    }
  } catch (error) {
    if (!isToolError(error)) throw error
    warnings.push(`Could not read ${request.remote} again to confirm the push: ${error.message}`)
    return { pushed: new Map(names.map((name) => [name, true])), warnings }
  }
}
