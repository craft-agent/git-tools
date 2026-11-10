import type { z } from "zod"
import { ToolError } from "../errors"
import { shortSha } from "../rewrite"
import type { PushKind, PushPreview, sendSchema } from "./schema"
import { branchTip } from "./select"

/** What a send pins: the remote, and per branch the commit to push and the remote commit it leases on. */
export type SendRequest = z.output<typeof sendSchema>

/** The kinds of push a send can make; `none` is a branch with nothing to push. */
export type SentKind = Exclude<PushKind, "none">

/** The words that name each kind of push, in the order a description lists them. */
export const KIND_WORDS: Record<SentKind, string> = {
  create: "new",
  fast_forward: "fast forward",
  force: "force",
}

/** A full commit id: 40 hex digits, or 64 in a repository that uses SHA-256, lowercase. */
const FULL_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/

function requireName(value: string, what: "remote" | "branch"): void {
  if (value === "" || value.trim() !== value || value.startsWith("-")) {
    throw new ToolError(
      "invalid_argument",
      `"${value}" is not a ${what} name; name a ${what}, not an option or a blank.`,
    )
  }
}

function requireFullId(value: string, what: string): void {
  if (!FULL_ID_PATTERN.test(value)) {
    throw new ToolError(
      "invalid_argument",
      `${what} must be a full lowercase commit id (40 hexadecimal digits, 64 with SHA-256), not "${value}"; pass the preview's send as it is.`,
    )
  }
}

function requireValidRequest({ remote, branches }: SendRequest): void {
  requireName(remote, "remote")
  const seen = new Set<string>()
  for (const { branch, sha, expect } of branches) {
    requireName(branch, "branch")
    if (seen.has(branch)) {
      throw new ToolError("invalid_argument", `${branch} is listed twice; list each branch once.`)
    }
    seen.add(branch)
    requireFullId(sha, `The sha of ${branch}`)
    if (expect !== null) requireFullId(expect, `The expect of ${branch}`)
  }
}

/**
 * The checks that need nothing but this repository: the names and commit ids
 * are well formed, no branch is listed twice, every branch exists (`not_found`)
 * and is still at its `sha` (`stale`, before anything runs).
 */
export async function requireLocalPins(root: string, request: SendRequest, signal?: AbortSignal): Promise<void> {
  requireValidRequest(request)
  for (const { branch, sha } of request.branches) {
    const tip = await branchTip(root, branch, signal)
    if (tip !== sha) {
      throw new ToolError("stale", `${branch} is at ${shortSha(tip)} now, not ${shortSha(sha)}; preview again.`, {
        details: { branch, expected: sha, now: tip },
      })
    }
  }
}

/**
 * Checks a fresh preview of the pinned branches against the request: each
 * remote branch must still be at the commit the request leases on, else
 * `stale`; a branch that has nothing left to push is `stale` too.
 */
export function requireRemoteUnmoved(preview: PushPreview, request: SendRequest): void {
  const now = new Map(preview.branches.map((entry) => [entry.branch, entry]))
  for (const { branch, sha, expect } of request.branches) {
    const live = now.get(branch)
    if (live === undefined || live.sha !== sha) {
      throw new ToolError("stale", `${branch} changed since the preview; preview again.`)
    }
    const tracking = `${request.remote}/${branch}`
    if (live.expect !== expect) {
      const where = live.expect === null ? "it is absent now" : `it is at ${shortSha(live.expect)} now`
      throw new ToolError("stale", `${tracking} moved since the preview: ${where}; preview again.`, {
        details: { branch, expected: expect, now: live.expect },
      })
    }
    if (live.kind === "none") {
      throw new ToolError("stale", `${tracking} already holds ${shortSha(sha)}; there is nothing to push.`, {
        details: { branch, expected: expect, now: live.expect },
      })
    }
  }
}
