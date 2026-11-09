/**
 * The one rule for rewriting commits (amend, fixup, rebase): a branch's own
 * commits may be rewritten even once pushed (the push then needs a force push),
 * but never the default branch, commits already on it, or commits another
 * remote branch holds too. Whether the hosting service protects the pushed
 * branch against force pushes is not read here; a pushed branch on GitHub gets
 * a warning that it was not checked.
 */

import { z } from "zod"
import { ToolError } from "./errors"
import { git, gitResult } from "./git"
import { defaultBranchRef } from "./tree"

/** How many hex characters of a commit id the messages show. */
const SHORT_SHA_LENGTH = 12

/** How many other branches a `shared` refusal names. */
const MAX_NAMED_BRANCHES = 5

/** Where git keeps the remote-tracking branches. */
const REMOTE_REFS_PREFIX = "refs/remotes/"

const REWRITE_RULES = ["detached", "default_branch", "merged", "shared"] as const

/** A remote URL on github.com: `https://`, `ssh://git@` and `git@github.com:` forms. */
const GITHUB_URL_PATTERN = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:[^@/]+@)?github\.com(?::\d+)?[:/]/i

/** The verdict of the rewrite rule on a range of commits. */
export const rewriteCheckSchema = z.object({
  allowed: z.boolean().describe("True when the commits may be rewritten."),
  branch: z.string().nullable().describe("The checked-out branch; null when HEAD is detached."),
  published: z
    .array(z.string())
    .describe("The branch's own remote branches (such as origin/feat) that already hold the commits being rewritten."),
  needs_force_push: z
    .boolean()
    .describe("True when the commits are published, so pushing the rewritten branch needs a force push with a lease."),
  refusals: z
    .array(
      z.object({
        rule: z.enum(REWRITE_RULES).describe("Which part of the rule refuses."),
        message: z.string().describe("Why, and what to do instead."),
      }),
    )
    .describe("Why the rewrite is refused; empty when allowed."),
  warnings: z.array(z.string()).describe("What was not checked and may still stop a push."),
})

/** The verdict of the rewrite rule: whether the commits may be rewritten, and what a push of them then needs. */
export type RewriteCheck = z.output<typeof rewriteCheckSchema>

/** One reason the rule refuses a rewrite. */
export type RewriteRefusal = RewriteCheck["refusals"][number]

/** A remote branch ref as `<remote>/<name>`, with the two parts split. */
export type RemoteRef = { remote: string; name: string; ref: string }

/** The first characters of a commit id, as the messages show it. */
export function shortSha(sha: string): string {
  return sha.slice(0, SHORT_SHA_LENGTH)
}

/** The full id of the commit `rev` names; `not_found` when it names none. */
export async function resolveCommit(root: string, rev: string, signal?: AbortSignal): Promise<string> {
  const resolved = await gitResult(["rev-parse", "--verify", "--quiet", "--end-of-options", `${rev}^{commit}`], {
    cwd: root,
    signal,
  })
  if (resolved.code !== 0) {
    throw new ToolError("not_found", `${rev} is not a commit in this clone; fetch it, or name another commit.`)
  }
  return resolved.stdout.trim()
}

/** The checked-out branch, or null when HEAD is detached. */
export async function currentBranch(root: string, signal?: AbortSignal): Promise<string | null> {
  const head = await gitResult(["symbolic-ref", "--quiet", "--short", "HEAD"], { cwd: root, signal })
  return head.code === 0 ? head.stdout.trim() || null : null
}

/** Whether `ancestor` is reachable from `descendant` (a commit counts as its own ancestor). */
export async function isAncestor(
  root: string,
  ancestor: string,
  descendant: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await gitResult(["merge-base", "--is-ancestor", ancestor, descendant], { cwd: root, signal })
  return result.code === 0
}

async function remoteNames(root: string, signal?: AbortSignal): Promise<string[]> {
  const out = await git(["remote"], { cwd: root, signal })
  return out
    .split("\n")
    .map((name) => name.trim())
    .filter(Boolean)
}

/** Splits `<remote>/<name>` against the known remotes: a remote name holds no slash, a branch name may. */
function splitRef(ref: string, remotes: string[]): RemoteRef | null {
  const remote = remotes.filter((name) => ref.startsWith(`${name}/`)).sort((a, b) => b.length - a.length)[0]
  return remote ? { remote, name: ref.slice(remote.length + 1), ref } : null
}

/**
 * The remote branches that count as `branch`'s own and exist here:
 * `<remote>/<branch>` on every remote, and the branch it pushes to when that has
 * the branch's own name. An upstream under another name does not count: a branch
 * cut from `origin/feat-a` tracks it, but feat-a is someone else's work.
 */
export async function ownRemoteRefs(root: string, branch: string, signal?: AbortSignal): Promise<RemoteRef[]> {
  const remotes = await remoteNames(root, signal)
  const candidates = new Map<string, RemoteRef>()
  for (const remote of remotes) {
    candidates.set(`${remote}/${branch}`, { remote, name: branch, ref: `${remote}/${branch}` })
  }
  const push = await gitResult(["rev-parse", "--abbrev-ref", "--symbolic-full-name", `${branch}@{push}`], {
    cwd: root,
    signal,
  })
  const pushRef = push.code === 0 ? splitRef(push.stdout.trim(), remotes) : null
  if (pushRef && pushRef.name === branch) candidates.set(pushRef.ref, pushRef)

  const existing: RemoteRef[] = []
  for (const candidate of candidates.values()) {
    const found = await gitResult(
      ["rev-parse", "--verify", "--quiet", `${REMOTE_REFS_PREFIX}${candidate.ref}^{commit}`],
      {
        cwd: root,
        signal,
      },
    )
    if (found.code === 0) existing.push(candidate)
  }
  return existing
}

/** Whether pushing HEAD to the branch's own remote branches now needs a force push. */
export async function needsForcePush(root: string, branch: string, signal?: AbortSignal): Promise<boolean> {
  for (const own of await ownRemoteRefs(root, branch, signal)) {
    if (!(await isAncestor(root, `${REMOTE_REFS_PREFIX}${own.ref}`, "HEAD", signal))) return true
  }
  return false
}

/**
 * The commits a rewrite replaces (reachable from HEAD, not from `exclude`) and
 * their roots: the ones whose parents all lie outside. A ref holds a commit of
 * the range exactly when it holds one of the roots, merged-in side branches
 * included.
 */
async function rangeRoots(root: string, exclude: string[], signal?: AbortSignal): Promise<string[]> {
  const out = await git(["rev-list", "--parents", "HEAD", "--not", ...exclude], { cwd: root, signal })
  const rows = out
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split(" "))
  const inRange = new Set(rows.map((row) => row[0]!))
  return rows.filter((row) => row.slice(1).every((parent) => !inRange.has(parent))).map((row) => row[0]!)
}

/** The remote branches (such as `origin/feat`, never a remote's symbolic HEAD) that contain at least one of `commits`. */
export async function remoteBranchesContaining(
  root: string,
  commits: string[],
  signal?: AbortSignal,
): Promise<string[]> {
  if (commits.length === 0) return []
  const out = await git(
    ["branch", "-r", ...commits.flatMap((commit) => ["--contains", commit]), "--format=%(refname)"],
    { cwd: root, signal },
  )
  return out
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.endsWith("/HEAD"))
    .map((line) => (line.startsWith(REMOTE_REFS_PREFIX) ? line.slice(REMOTE_REFS_PREFIX.length) : line))
}

async function githubWarnings(root: string, holding: RemoteRef[], signal?: AbortSignal): Promise<string[]> {
  const warnings: string[] = []
  for (const own of holding) {
    const url = await gitResult(["remote", "get-url", own.remote], { cwd: root, signal })
    if (url.code === 0 && GITHUB_URL_PATTERN.test(url.stdout.trim())) {
      warnings.push(
        `${own.ref} is on GitHub; whether it is protected against force pushes was not checked, so a force push may still be refused there.`,
      )
    }
  }
  return warnings
}

/**
 * Checks a rewrite of every commit after `base` up to HEAD; by default `oldest`
 * and everything after it, leaving out what the default branch holds (a fold
 * keeps the base and never replays what was merged in from it). `oldest` should
 * be an ancestor of HEAD. An `oldest` or `base` that is no commit throws
 * `not_found`.
 */
export async function checkRewrite(
  root: string,
  oldest: string,
  options: { base?: string; signal?: AbortSignal } = {},
): Promise<RewriteCheck> {
  const { signal } = options
  const oldestSha = await resolveCommit(root, oldest, signal)
  const baseSha = options.base === undefined ? undefined : await resolveCommit(root, options.base, signal)

  const branch = await currentBranch(root, signal)
  if (!branch) {
    return {
      allowed: false,
      branch: null,
      published: [],
      needs_force_push: false,
      refusals: [
        {
          rule: "detached",
          message: "HEAD is detached; check out the branch whose commits these are first.",
        },
      ],
      warnings: [],
    }
  }

  const refusals: RewriteRefusal[] = []
  const defaultRef = await defaultBranchRef(root, signal)
  const remotes = await remoteNames(root, signal)
  const exclude =
    baseSha === undefined
      ? [
          ...(await git(["rev-parse", `${oldestSha}^@`], { cwd: root, signal })).split("\n").filter(Boolean),
          ...(defaultRef ? [defaultRef] : []),
        ]
      : [baseSha]
  const roots = await rangeRoots(root, exclude, signal)

  if (!defaultRef && remotes.length > 0) {
    refusals.push({
      rule: "default_branch",
      message:
        "The remote default branch is not known here (no origin/HEAD, origin/main or origin/master); run `git remote set-head origin --auto` first.",
    })
  } else if (
    defaultRef ? branch === defaultRef.slice(defaultRef.indexOf("/") + 1) : ["main", "master"].includes(branch)
  ) {
    refusals.push({
      rule: "default_branch",
      message: `${branch} is the default branch; its history is never rewritten. Make a new commit instead.`,
    })
  } else if (defaultRef) {
    for (const commit of [oldestSha, ...roots]) {
      if (await isAncestor(root, commit, defaultRef, signal)) {
        refusals.push({
          rule: "merged",
          message: `${shortSha(commit)} is already on ${defaultRef}; make a new commit that fixes it instead.`,
        })
        break
      }
    }
  }

  const own = await ownRemoteRefs(root, branch, signal)
  const ownRefs = new Set(own.map((candidate) => candidate.ref))
  const containing = await remoteBranchesContaining(root, roots, signal)
  const holding = own.filter((candidate) => containing.includes(candidate.ref))
  const others = containing.filter((ref) => !ownRefs.has(ref) && ref !== defaultRef)
  if (others.length > 0) {
    refusals.push({
      rule: "shared",
      message: `Other branches also hold these commits (${others.slice(0, MAX_NAMED_BRANCHES).join(", ")}); rewriting them would leave that work behind. Make a new commit instead.`,
    })
  }

  const warnings = refusals.length === 0 ? await githubWarnings(root, holding, signal) : []
  const published = holding.map((candidate) => candidate.ref)
  return {
    allowed: refusals.length === 0,
    branch,
    published,
    needs_force_push: published.length > 0,
    refusals,
    warnings,
  }
}
