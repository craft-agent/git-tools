import { stat } from "node:fs/promises"
import { z } from "zod"
import { git, gitResult } from "../git"
import { realpathOrSelf } from "../paths"
import { defaultBranchRef, gitPath, operationInProgress } from "../tree"
import { branchName, listWorktrees } from "../worktrees"

const LIST_MAX = 50

function capped<T>(items: T[]) {
  return {
    count: items.length,
    items: items.slice(0, LIST_MAX),
    truncated: items.length > LIST_MAX,
  }
}

/** The local working tree snapshot returned by the status method. */
export const statusSchema = z.object({
  branch: z.string().nullable().describe("The current branch name, or null when detached."),
  head: z.string().nullable().describe("The full commit sha of HEAD, or null when unborn."),
  detached: z.boolean().describe("Whether HEAD is detached from any branch."),
  unborn: z.boolean().describe("Whether the repository has no commits yet."),
  upstream: z
    .object({
      ref: z.string().describe("The upstream tracking branch ref."),
      ahead: z.number().int().describe("How many commits HEAD is ahead of upstream."),
      behind: z.number().int().describe("How many commits HEAD is behind upstream."),
      gone: z.boolean().describe("Whether the upstream ref is configured but does not exist on the remote."),
    })
    .nullable()
    .describe("The upstream tracking branch, or null if none is configured."),
  base: z
    .object({
      ref: z.string().describe("The remote default branch ref."),
      merge_base: z
        .string()
        .nullable()
        .describe("The common ancestor commit sha between HEAD and the base ref, or null if none."),
      ahead: z.number().int().describe("How many commits HEAD is ahead of the base ref."),
      behind: z.number().int().describe("How many commits HEAD is behind the base ref."),
      commits: z
        .array(
          z.object({
            sha: z.string().describe("The full commit sha."),
            subject: z.string().describe("The commit subject line."),
          }),
        )
        .describe("Commits on HEAD since the merge-base, newest first."),
      truncated: z.boolean().describe(`Whether more commits were found than the limit of ${LIST_MAX}.`),
    })
    .nullable()
    .describe("Comparison against the remote default branch, or null if unborn or no remote default exists."),
  operation: z
    .enum(["rebase", "am", "merge", "cherry-pick", "revert", "bisect"])
    .nullable()
    .describe("An operation currently in progress, or null if idle."),
  conflicted: z
    .object({
      count: z.number().int().describe("Total number of conflicted files."),
      items: z.array(z.string()).describe("Paths of conflicted files."),
      truncated: z.boolean().describe(`Whether more conflicted files were found than the limit of ${LIST_MAX}.`),
    })
    .describe("Conflicted files."),
  staged: z
    .object({
      count: z.number().int().describe("Total number of staged changes."),
      items: z
        .array(
          z.object({
            path: z.string().describe("The file path."),
            status: z.string().describe("The staging status code (e.g. M, A, D, R)."),
            from: z.string().optional().describe("For renames or copies, the original path."),
          }),
        )
        .describe("Staged changes in the index."),
      truncated: z.boolean().describe(`Whether more staged changes were found than the limit of ${LIST_MAX}.`),
    })
    .describe("Staged changes in the index."),
  unstaged: z
    .object({
      count: z.number().int().describe("Total number of unstaged changes."),
      items: z
        .array(
          z.object({
            path: z.string().describe("The file path."),
            status: z.string().describe("The working tree status code (e.g. M, D)."),
          }),
        )
        .describe("Unstaged changes in the working tree."),
      truncated: z.boolean().describe(`Whether more unstaged changes were found than the limit of ${LIST_MAX}.`),
    })
    .describe("Unstaged changes in the working tree."),
  untracked: z
    .object({
      count: z.number().int().describe("Total number of untracked files."),
      items: z.array(z.string()).describe("Paths of untracked files."),
      truncated: z.boolean().describe(`Whether more untracked files were found than the limit of ${LIST_MAX}.`),
    })
    .describe("Untracked files not ignored by git."),
  clean: z.boolean().describe("Whether the working tree has no staged, unstaged, untracked, or conflicted changes."),
  stashes: z
    .object({
      count: z.number().int().describe("Total number of stashes."),
      items: z
        .array(
          z.object({
            ref: z.string().describe("The stash ref, such as stash@{0}."),
            subject: z.string().describe("The stash description or commit subject."),
          }),
        )
        .describe("Stashes, newest first."),
      truncated: z.boolean().describe(`Whether more stashes were found than the limit of ${LIST_MAX}.`),
    })
    .describe("Stashed changes."),
  worktrees: z
    .array(
      z.object({
        path: z.string().describe("The path of the worktree."),
        branch: z.string().nullable().describe("The checked-out branch name, or null when detached."),
        head: z.string().nullable().describe("The HEAD commit sha of the worktree."),
        current: z.boolean().describe("Whether this worktree is the current working tree."),
      }),
    )
    .describe("Worktrees for this repository."),
  last_fetch: z
    .string()
    .nullable()
    .describe("ISO timestamp when FETCH_HEAD was last modified, or null if never fetched."),
})

/** A validated local working tree snapshot. */
export type StatusResult = z.output<typeof statusSchema>

type StagedItem = StatusResult["staged"]["items"][number]
type UnstagedItem = StatusResult["unstaged"]["items"][number]

type WorktreeEntry = StatusResult["worktrees"][number]

async function readWorktrees(root: string, signal?: AbortSignal): Promise<WorktreeEntry[]> {
  const rootReal = await realpathOrSelf(root)
  return Promise.all(
    (await listWorktrees(root, signal)).map(async ({ path, branch, head }): Promise<WorktreeEntry> => ({
      path,
      branch: branchName(branch),
      head,
      current: (await realpathOrSelf(path)) === rootReal,
    })),
  )
}

function parseSubjectLines(output: string): [string, string][] {
  return output
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const nul = line.indexOf("\0")
      return nul === -1 ? [line, ""] : [line.slice(0, nul), line.slice(nul + 1)]
    })
}

function parsePorcelainV2(stdout: string) {
  let oid: string | null = null
  let headName: string | null = null
  let upstreamRef: string | null = null
  let ahead = 0
  let behind = 0
  let hasAb = false

  const staged: StagedItem[] = []
  const unstaged: UnstagedItem[] = []
  const untracked: string[] = []
  const conflicted: string[] = []

  const fields = stdout.split("\0")
  for (let i = 0; i < fields.length; i++) {
    const rec = fields[i]
    if (!rec) continue
    if (rec.startsWith("# branch.oid ")) {
      oid = rec.slice(13)
    } else if (rec.startsWith("# branch.head ")) {
      headName = rec.slice(14)
    } else if (rec.startsWith("# branch.upstream ")) {
      upstreamRef = rec.slice(18)
    } else if (rec.startsWith("# branch.ab ")) {
      const match = rec.match(/\+(\d+) -(\d+)/)
      if (match) {
        ahead = Number.parseInt(match[1]!, 10)
        behind = Number.parseInt(match[2]!, 10)
        hasAb = true
      }
    } else if (rec.startsWith("? ")) {
      untracked.push(rec.slice(2))
    } else if (rec.startsWith("u ")) {
      const parts = rec.split(" ")
      conflicted.push(parts.slice(10).join(" "))
    } else if (rec.startsWith("1 ")) {
      const parts = rec.split(" ")
      const xy = parts[1] ?? ".."
      const path = parts.slice(8).join(" ")
      if (xy[0] && xy[0] !== ".") staged.push({ path, status: xy[0] })
      if (xy[1] && xy[1] !== ".") unstaged.push({ path, status: xy[1] })
    } else if (rec.startsWith("2 ")) {
      const parts = rec.split(" ")
      const xy = parts[1] ?? ".."
      const path = parts.slice(9).join(" ")
      const from = fields[++i]
      if (xy[0] && xy[0] !== ".") {
        staged.push({ path, status: xy[0], ...(from ? { from } : {}) })
      }
      if (xy[1] && xy[1] !== ".") {
        unstaged.push({ path, status: xy[1] })
      }
    }
  }

  const unborn = oid === "(initial)"
  const head = unborn ? null : oid
  const detached = headName === "(detached)"
  const branch = detached ? null : headName

  let upstream: StatusResult["upstream"] = null
  if (upstreamRef) {
    if (hasAb) {
      upstream = { ref: upstreamRef, ahead, behind, gone: false }
    } else {
      upstream = { ref: upstreamRef, ahead: 0, behind: 0, gone: true }
    }
  }

  return { branch, head, detached, unborn, upstream, staged, unstaged, untracked, conflicted }
}

/**
 * Reads a comprehensive snapshot of the working tree state in `root`.
 */
export async function readStatus(root: string, signal?: AbortSignal): Promise<StatusResult> {
  const stdout = await git(["--no-optional-locks", "status", "--porcelain=v2", "--branch", "-z"], {
    cwd: root,
    signal,
  })
  const { branch, head, detached, unborn, upstream, staged, unstaged, untracked, conflicted } = parsePorcelainV2(stdout)
  const defaultRef = await defaultBranchRef(root, signal)
  let base: StatusResult["base"] = null
  if (defaultRef && !unborn) {
    const mergeBaseResult = await gitResult(["merge-base", "HEAD", defaultRef], { cwd: root, signal })
    if (mergeBaseResult.code !== 0) {
      base = {
        ref: defaultRef,
        merge_base: null,
        ahead: 0,
        behind: 0,
        commits: [],
        truncated: false,
      }
    } else {
      const merge_base = mergeBaseResult.stdout.trim()
      const counts = await git(["rev-list", "--left-right", "--count", `${defaultRef}...HEAD`], {
        cwd: root,
        signal,
      })
      const parts = counts.trim().split(/\s+/)
      const baseBehind = Number.parseInt(parts[0] ?? "0", 10) || 0
      const baseAhead = Number.parseInt(parts[1] ?? "0", 10) || 0
      const log = await git(["log", "--format=%H%x00%s", `-${LIST_MAX + 1}`, `${defaultRef}..HEAD`], {
        cwd: root,
        signal,
      })
      const rawCommits = parseSubjectLines(log).map(([sha, subject]) => ({ sha, subject }))
      base = {
        ref: defaultRef,
        merge_base,
        ahead: baseAhead,
        behind: baseBehind,
        commits: rawCommits.slice(0, LIST_MAX),
        truncated: rawCommits.length > LIST_MAX,
      }
    }
  }

  const stashOutput = await git(["stash", "list", "--format=%gd%x00%s"], {
    cwd: root,
    signal,
  })
  const rawStashes = parseSubjectLines(stashOutput).map(([ref, subject]) => ({ ref, subject }))

  const worktrees = await readWorktrees(root, signal)

  const fetchHead = await gitPath(root, "FETCH_HEAD", signal)
  let last_fetch: string | null = null
  try {
    const stats = await stat(fetchHead)
    last_fetch = stats.mtime.toISOString()
  } catch {
    last_fetch = null
  }

  const clean = staged.length === 0 && unstaged.length === 0 && untracked.length === 0 && conflicted.length === 0

  const operation = await operationInProgress(root, signal)

  return {
    branch,
    head,
    detached,
    unborn,
    upstream,
    base,
    operation,
    conflicted: capped(conflicted),
    staged: capped(staged),
    unstaged: capped(unstaged),
    untracked: capped(untracked),
    clean,
    stashes: capped(rawStashes),
    worktrees,
    last_fetch,
  }
}
