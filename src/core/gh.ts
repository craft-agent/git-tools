import { z } from "zod"
import { ToolError, type ErrorCode } from "./errors"
import { exec, type ExecResult } from "./exec"
import { passedEnv } from "./git"

/** The time limit of the force-push protection read; an approval prompt's describe has 10 s and runs the rewrite rule. */
export const PROTECTION_READ_TIMEOUT_MS = 8_000

const MAX_MESSAGE_LENGTH = 500

/** The only host `githubRepo` recognizes, so the only one a query goes to. */
const GITHUB_HOST = "github.com"

const GH_MISSING_MESSAGE = "the GitHub CLI (gh) is not installed or not on PATH"

/** Settings that keep `gh` from prompting, paging, coloring or announcing updates. */
const FORCED_ENV: Record<string, string> = {
  GH_PROMPT_DISABLED: "1",
  GH_NO_UPDATE_NOTIFIER: "1",
  GH_SPINNER_DISABLED: "1",
  NO_COLOR: "1",
  CLICOLOR: "0",
  GH_PAGER: "cat",
}

/** The reasons a branch counts as protected, as the refusal states them. */
const BRANCH_PROTECTION_REASON = "branch protection blocks force pushes"
const RULESET_REASON = "a ruleset blocks force pushes"

/** The type of a ruleset rule that forbids force pushes. */
const NON_FAST_FORWARD_RULE = "NON_FAST_FORWARD"

/** The branch's force-push rules, in one query: `$ref` is the full ref name on GitHub. */
const PROTECTION_QUERY = `query($owner: String!, $name: String!, $ref: String!) {
  repository(owner: $owner, name: $name) {
    ref(qualifiedName: $ref) {
      refUpdateRule { allowsForcePushes }
      rules(first: 100) { nodes { type } }
    }
  }
}`

/** Failure texts of `gh`, in the order they are tried; the first code whose pattern matches wins. */
const FAILURE_PATTERNS = [
  ["unauthenticated", /gh auth login|not logged into|authentication required|http 401|bad credentials/i],
  ["rate_limited", /rate limit|secondary rate|http 429/i],
  ["not_found", /http 404|could not resolve to a|graphql: could not resolve/i],
  ["forbidden", /http 403|resource not accessible|must have[\s\S]*permission|insufficient scopes/i],
] as const satisfies readonly (readonly [ErrorCode, RegExp])[]

const FAILURE_HINTS: Partial<Record<ErrorCode, string>> = {
  unauthenticated: "gh is not logged in; run `gh auth login`.",
  rate_limited: "GitHub's rate limit was reached; wait and retry.",
}

/** A remote URL on github.com (`https://`, `ssh://git@` and `git@github.com:` forms) with the repository it names. */
const GITHUB_URL_PATTERN =
  /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?github\.com(?::\d+)?[:/]([^/:\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i

const protectionReplySchema = z.object({
  repository: z
    .object({
      ref: z
        .object({
          refUpdateRule: z.object({ allowsForcePushes: z.boolean() }).nullish(),
          rules: z.object({ nodes: z.array(z.object({ type: z.string() }).nullable()) }).nullish(),
        })
        .nullable(),
    })
    .nullable(),
})

/** A repository on GitHub. */
export type GithubRepo = { owner: string; name: string }

/** Whether GitHub blocks force pushes to a branch, and the reason when it does. */
export type ForcePushProtection = { protected: true; reason: string } | { protected: false }

/** Options for one `gh` call. */
export type GhOptions = {
  cwd: string
  signal?: AbortSignal
  /** Stops the call after this many milliseconds. */
  timeoutMs: number
}

/**
 * The environment every `gh` call gets: the variables the git runner passes
 * through (`PATH`, `HOME`, the proxies and `gh`'s authentication), read from
 * `process.env` at call time, then the forced ones. `GH_REPO` is never passed:
 * a stray one would silently redirect a call.
 */
export function ghEnv(): Record<string, string> {
  return { ...passedEnv(), ...FORCED_ENV }
}

/** The repository a GitHub remote URL names, or null for any other URL or host. */
export function githubRepo(url: string): GithubRepo | null {
  const match = GITHUB_URL_PATTERN.exec(url.trim())
  return match ? { owner: match[1]!, name: match[2]! } : null
}

function isSpawnNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function trimmed(text: string): string {
  return text.length > MAX_MESSAGE_LENGTH ? `${text.slice(0, MAX_MESSAGE_LENGTH)}…` : text
}

/** The error for a failure whose text `gh` or GitHub gave; the code comes from the text, `upstream_error` when it matches none. */
function failure(text: string, code: number): ToolError {
  const matched = FAILURE_PATTERNS.find(([, pattern]) => pattern.test(text))?.[0] ?? "upstream_error"
  const prefix = FAILURE_HINTS[matched] ?? `gh failed (exit ${code}):`
  const detail = trimmed(text)
  return new ToolError(matched, detail ? `${prefix} ${detail}` : prefix)
}

/** The error for a call that was stopped by a signal or its time limit, or undefined for one that ran to its end. */
function stoppedError(result: ExecResult, timeoutMs: number): ToolError | undefined {
  if (!result.signal && !result.timedOut) return undefined
  const stoppedBy = result.signal ? ` and was stopped with ${result.signal}` : ""
  const message = result.timedOut
    ? `gh timed out after ${timeoutMs / 1000} seconds${stoppedBy}.`
    : `gh was stopped with ${result.signal}.`
  return new ToolError("upstream_error", message)
}

function parseReply(stdout: string): { data?: unknown; errors?: unknown } | undefined {
  const text = stdout.trim()
  if (!text) return undefined
  try {
    const parsed: unknown = JSON.parse(text)
    return typeof parsed === "object" && parsed !== null ? parsed : undefined
  } catch {
    return undefined
  }
}

function errorMessages(errors: unknown[]): string {
  return errors
    .map((entry) => {
      const message = typeof entry === "object" && entry !== null ? (entry as { message?: unknown }).message : undefined
      return typeof message === "string" ? message : JSON.stringify(entry)
    })
    .join("; ")
}

/**
 * Runs one GraphQL query through `gh api graphql` against github.com and
 * returns its `data`; `--hostname` keeps a `GH_HOST` set for another host from
 * redirecting it. Variables are passed as strings. Throws a `ToolError`:
 * `upstream_error` when `gh` is missing, cannot start, or is stopped or times out; for a failure
 * GitHub or `gh` reports (errors in the reply, or a non-zero exit),
 * `unauthenticated`, `rate_limited`, `not_found` or `forbidden` as its text
 * says, else `upstream_error`. An abort rejects as `exec` raises it.
 */
export async function ghGraphql<T>(query: string, vars: Record<string, string>, options: GhOptions): Promise<T> {
  const args = [
    "api",
    "graphql",
    "--hostname",
    GITHUB_HOST,
    "-f",
    `query=${query}`,
    ...Object.entries(vars).flatMap(([k, v]) => ["-f", `${k}=${v}`]),
  ]
  let result: ExecResult
  try {
    result = await exec(["gh", ...args], {
      cwd: options.cwd,
      env: ghEnv(),
      signal: options.signal,
      timeoutMs: options.timeoutMs,
    })
  } catch (error) {
    if (isSpawnNotFound(error)) throw new ToolError("upstream_error", GH_MISSING_MESSAGE, { cause: error })
    if (error instanceof Error && error.name !== "AbortError") {
      throw new ToolError("upstream_error", `gh could not be started: ${trimmed(error.message)}`, { cause: error })
    }
    throw error
  }
  const stopped = stoppedError(result, options.timeoutMs)
  if (stopped) throw stopped

  const reply = parseReply(result.stdout)
  if (Array.isArray(reply?.errors) && reply.errors.length > 0) {
    throw failure(errorMessages(reply.errors), result.code)
  }
  if (result.code !== 0) throw failure(result.stderr.trim() || result.stdout.trim(), result.code)
  if (reply?.data === undefined || reply.data === null) {
    throw new ToolError("upstream_error", "GitHub returned no data for the query.")
  }
  return reply.data as T
}

/**
 * Whether GitHub blocks force pushes to `branch` (its name on the remote) of
 * `repo`: by branch protection, or by a ruleset (which wins when both do).
 * Neither read reflects who may bypass the rule, so protected is the safe
 * answer. Throws `not_found` when GitHub has no such branch, and whatever
 * `ghGraphql` throws; the read stops after `PROTECTION_READ_TIMEOUT_MS`.
 */
export async function forcePushProtection(
  repo: GithubRepo,
  branch: string,
  options: Omit<GhOptions, "timeoutMs">,
): Promise<ForcePushProtection> {
  const data = await ghGraphql<unknown>(
    PROTECTION_QUERY,
    { owner: repo.owner, name: repo.name, ref: `refs/heads/${branch}` },
    { ...options, timeoutMs: PROTECTION_READ_TIMEOUT_MS },
  )
  const reply = protectionReplySchema.safeParse(data)
  if (!reply.success) throw new ToolError("upstream_error", "GitHub's reply about the branch could not be read.")
  const ref = reply.data.repository?.ref
  if (!ref) throw new ToolError("not_found", `${branch} is not on GitHub`)
  if (ref.rules?.nodes.some((rule) => rule?.type === NON_FAST_FORWARD_RULE)) {
    return { protected: true, reason: RULESET_REASON }
  }
  if (ref.refUpdateRule?.allowsForcePushes === false) return { protected: true, reason: BRANCH_PROTECTION_REASON }
  return { protected: false }
}
