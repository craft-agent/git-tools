/**
 * The one rule for rewriting commits (amend, fixup, rebase): a branch's own
 * commits may be rewritten even once pushed (the push then needs a force push),
 * but never the default branch, commits already on it, or commits another
 * remote branch holds too. On a stack of layer branches, the remote branches of
 * every layer count as the branch's own, and a rewrite that would leave layers
 * above it on the old commits is refused, unless it is a rebase of the whole
 * stack. When a pushed branch is on GitHub, whether GitHub protects it against
 * force pushes is read as well, and a protected branch is refused; a read that
 * fails is a warning, since the rewrite itself stays local and GitHub refuses
 * the force push on its own.
 */

import { z } from "zod"
import { isToolError, ToolError } from "./errors"
import { forcePushProtection, githubRepo, type ForcePushProtection } from "./gh"
import { git, gitResult } from "./git"
import { forkDetails, layersAbove, readStack, stackBranches, topBranch, type ForkDetails, type Stack } from "./stack"
import { currentBranch, defaultBranchRef, isAncestor } from "./tree"

export { currentBranch, isAncestor } from "./tree"

/** How many hex characters of a commit id the messages show. */
const SHORT_SHA_LENGTH = 12

/** How many other branches a `shared` refusal names. */
const MAX_NAMED_BRANCHES = 5

/** Where git keeps the remote-tracking branches. */
const REMOTE_REFS_PREFIX = "refs/remotes/"

const REWRITE_RULES = ["detached", "default_branch", "merged", "shared", "protected", "layers_above"] as const

/** The verdict of the rewrite rule on a range of commits. */
export const rewriteCheckSchema = z.object({
  allowed: z.boolean().describe("True when the commits may be rewritten."),
  branch: z.string().nullable().describe("The checked-out branch; null when HEAD is detached."),
  published: z
    .array(z.string())
    .describe(
      "The remote branches (such as origin/feat) of the branch and of its stack's layers that already hold the commits being rewritten.",
    ),
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
 * Whether replacing the commit `amended` (HEAD) with an amended one, which
 * keeps its parent, would leave a push to the branch's own remote branches
 * needing a force push: some own remote branch is not contained in that
 * parent. A root commit has no parent, so any own remote branch makes it true.
 * Reads local refs only.
 */
export async function needsForcePushAfterAmend(
  root: string,
  branch: string,
  amended: string,
  signal?: AbortSignal,
): Promise<boolean> {
  const own = await ownRemoteRefs(root, branch, signal)
  if (own.length === 0) return false
  const parent = await gitResult(["rev-parse", "--verify", "--quiet", `${amended}^`], { cwd: root, signal })
  if (parent.code !== 0) return true
  for (const candidate of own) {
    if (!(await isAncestor(root, `${REMOTE_REFS_PREFIX}${candidate.ref}`, parent.stdout.trim(), signal))) return true
  }
  return false
}

/**
 * The commits a rewrite replaces (reachable from `tip`, not from `exclude`) and
 * their roots: the ones whose parents all lie outside. A ref holds a commit of
 * the range exactly when it holds one of the roots, merged-in side branches
 * included.
 */
async function rangeRoots(root: string, tip: string, exclude: string[], signal?: AbortSignal): Promise<string[]> {
  const out = await git(["rev-list", "--parents", tip, "--not", ...exclude], { cwd: root, signal })
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

/**
 * Reads, for each of `holding` on a GitHub remote, whether GitHub blocks force
 * pushes to it: one read per repository and branch name. A protected branch is
 * a refusal, a read that fails a warning; a remote not on GitHub is skipped.
 */
async function readProtection(
  root: string,
  holding: RemoteRef[],
  signal?: AbortSignal,
): Promise<{ refusals: RewriteRefusal[]; warnings: string[] }> {
  const refusals: RewriteRefusal[] = []
  const warnings: string[] = []
  const reads = new Map<string, ForcePushProtection | ToolError>()
  for (const own of holding) {
    const url = await gitResult(["remote", "get-url", own.remote], { cwd: root, signal })
    const repo = url.code === 0 ? githubRepo(url.stdout) : null
    if (!repo) continue

    const key = `${repo.owner}/${repo.name}#${own.name}`.toLowerCase()
    let read = reads.get(key)
    if (!read) {
      try {
        read = await forcePushProtection(repo, own.name, { cwd: root, signal })
      } catch (error) {
        if (!isToolError(error)) throw error
        read = error
      }
      reads.set(key, read)
    }

    if (isToolError(read)) {
      warnings.push(
        `Could not read whether ${own.ref} is protected against force pushes on GitHub (${read.message}); a force push may still be refused there.`,
      )
    } else if (read.protected) {
      refusals.push({
        rule: "protected",
        message: `${own.ref} cannot be force-pushed: ${read.reason}. Make a new commit instead.`,
      })
    }
  }
  return { refusals, warnings }
}

/** The branches named in a message, at most `MAX_NAMED_BRANCHES` of them. */
function namedBranches(branches: string[]): string {
  const more = branches.length - MAX_NAMED_BRANCHES
  return `${branches.slice(0, MAX_NAMED_BRANCHES).join(", ")}${more > 0 ? ` and ${more} more` : ""}`
}

/**
 * The refusals for a rewrite at a layer that has layers above it and, when it
 * rewrites HEAD itself (`amending`), other branches on its tip, which a fixup
 * committed here would leave to the rebase of the stack.
 */
function layersAboveRefusals(stack: Stack, amending: boolean): RewriteRefusal[] {
  const refusals: RewriteRefusal[] = []
  const above = layersAbove(stack).flatMap((layer) => layer.branches)
  if (above.length > 0) {
    refusals.push({
      rule: "layers_above",
      message: `Rewriting here would leave ${namedBranches(above)} on the old commits. Check out ${topBranch(stack)}, commit the fix there as a fixup, and rebase the stack.`,
    })
  }
  const { branches, tip } = stack.layers[stack.position]!
  if (amending && branches.length > 1) {
    refusals.push({
      rule: "layers_above",
      message: `${namedBranches(branches.slice(1))} point at this commit too; amending it would leave them on the old one. Commit the fix as a fixup of ${shortSha(tip)} instead, then rebase the stack.`,
    })
  }
  return refusals
}

/** The refusal for a line that forks above the current branch. */
function forkRefusal(details: ForkDetails, branch: string): RewriteRefusal {
  return {
    rule: "layers_above",
    message: `Rewriting here would leave the branches above ${branch} on the old commits, and they fork (the candidate tops are ${namedBranches(details.candidate_tops)}). Check out the one the stack ends at, commit the fix there as a fixup, and rebase the stack.`,
  }
}

/**
 * Reads the stack the rule uses. A line that forks above the branch comes back
 * as `fork`; it is rethrown for a rewrite of the whole stack, which cannot tell
 * which line is meant.
 */
async function readStackForRule(
  root: string,
  wholeStack: boolean,
  signal?: AbortSignal,
): Promise<{ stack: Stack | null; fork: ForkDetails | null }> {
  try {
    return { stack: await readStack(root, { signal }), fork: null }
  } catch (error) {
    const fork = isToolError(error) && error.code === "invalid_argument" ? forkDetails(error) : null
    if (wholeStack || !fork) throw error
    return { stack: null, fork }
  }
}

/**
 * Checks a rewrite of every commit after `base` up to HEAD; by default `oldest`
 * and everything after it, leaving out what the default branch holds (a fold
 * keeps the base and never replays what was merged in from it). `oldest` should
 * be an ancestor of HEAD. An `oldest` or `base` that is no commit throws
 * `not_found`.
 *
 * On a stack of layer branches, the remote branches of every layer count as the
 * branch's own. A rewrite from HEAD is refused (`layers_above`) when layers
 * above it would stay on the old commits, and, with `amending` (HEAD itself is
 * replaced), when other branches on its tip would; a fixup committed on a
 * branch whose tip others share is fine, since the rebase of the stack moves
 * them. `wholeStack` is for a rewrite that moves every layer up to the top, and
 * takes the commits it replaces from the top's tip instead; it ignores
 * `amending`. A line that forks above the branch is a `layers_above` refusal,
 * and an `invalid_argument` error with `wholeStack`.
 */
export async function checkRewrite(
  root: string,
  oldest: string,
  options: { base?: string; signal?: AbortSignal; wholeStack?: boolean; amending?: boolean } = {},
): Promise<RewriteCheck> {
  const { signal, wholeStack = false, amending = false } = options
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
  const { stack, fork } = await readStackForRule(root, wholeStack, signal)
  if (fork) refusals.push(forkRefusal(fork, branch))
  else if (stack && !wholeStack) refusals.push(...layersAboveRefusals(stack, amending))

  const defaultRef = await defaultBranchRef(root, signal)
  const remotes = await remoteNames(root, signal)
  const exclude =
    baseSha === undefined
      ? [
          ...(await git(["rev-parse", `${oldestSha}^@`], { cwd: root, signal })).split("\n").filter(Boolean),
          ...(defaultRef ? [defaultRef] : []),
        ]
      : [baseSha]
  const rewriteTip = stack && wholeStack ? stack.layers[stack.layers.length - 1]!.tip : "HEAD"
  const roots = await rangeRoots(root, rewriteTip, exclude, signal)

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

  const own: RemoteRef[] = []
  const lineBranches = stack ? stackBranches(stack) : (fork?.line_branches ?? [branch])
  for (const name of lineBranches) own.push(...(await ownRemoteRefs(root, name, signal)))
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

  const protection =
    refusals.length === 0 ? await readProtection(root, holding, signal) : { refusals: [], warnings: [] }
  refusals.push(...protection.refusals)
  const published = holding.map((candidate) => candidate.ref)
  return {
    allowed: refusals.length === 0,
    branch,
    published,
    needs_force_push: published.length > 0,
    refusals,
    warnings: protection.warnings,
  }
}
