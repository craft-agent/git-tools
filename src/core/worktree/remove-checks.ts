import { ToolError } from "../errors"
import { git } from "../git"
import { shortSha } from "../rewrite"
import { operationInProgress } from "../tree"

/** How many files a `dirty_tree` refusal lists. */
const MAX_LISTED_FILES = 50

/** How many commits a `dirty_tree` refusal lists. */
const MAX_LISTED_COMMITS = 20

/** The status letters after which a second path follows: the original of a rename or a copy. */
const RENAME_OR_COPY = new Set(["R", "C"])

/** The shortest entry of `status --porcelain -z`: two status letters, a space and a path of one character. */
const MIN_STATUS_ENTRY_LENGTH = 4

/** The status letters and the path of a file `git status` lists. */
type ChangedFile = { status: string; path: string }

/** A commit no branch, remote branch or tag holds. */
type UnheldCommit = { sha: string; subject: string }

/** Parses `git status --porcelain=v1 -z`: `XY path`, and a rename or copy is followed by its original path. */
function parseChangedFiles(porcelain: string): ChangedFile[] {
  const files: ChangedFile[] = []
  const tokens = porcelain.split("\0")
  for (let index = 0; index < tokens.length; index++) {
    const entry = tokens[index]!
    if (entry.length < MIN_STATUS_ENTRY_LENGTH) continue
    const status = entry.slice(0, 2)
    files.push({ status, path: entry.slice(3) })
    if (RENAME_OR_COPY.has(status[0]!) || RENAME_OR_COPY.has(status[1]!)) index++
  }
  return files
}

/** Throws `operation_in_progress` when a rebase, merge, cherry-pick, revert or bisect is in progress in the working tree `directory`. */
export async function requireNoOperation(directory: string, signal?: AbortSignal): Promise<void> {
  const operation = await operationInProgress(directory, signal)
  if (operation) {
    throw new ToolError(
      "operation_in_progress",
      `A ${operation} is in progress in ${directory}; finish or abort it there before removing the worktree.`,
    )
  }
}

/**
 * Throws `dirty_tree` when the working tree `directory` has modified, staged or
 * untracked files (ignored files do not count). `details.files` lists the
 * first of them with their status letters, and `details.files_total` counts
 * them all.
 */
export async function requireNoUncommittedFiles(directory: string, signal?: AbortSignal): Promise<void> {
  const files = parseChangedFiles(
    await git(["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=all"], {
      cwd: directory,
      signal,
    }),
  )
  if (files.length === 0) return
  throw new ToolError(
    "dirty_tree",
    `${directory} has uncommitted changes (${files.length} ${files.length === 1 ? "file" : "files"}); commit, stash or discard them there before removing the worktree.`,
    { details: { files: files.slice(0, MAX_LISTED_FILES), files_total: files.length } },
  )
}

/** The commits `HEAD` has that no branch, remote branch or tag holds, newest first: at most `MAX_LISTED_COMMITS` of them, and how many there are. */
async function unheldCommits(
  directory: string,
  signal?: AbortSignal,
): Promise<{ listed: UnheldCommit[]; total: number }> {
  const heldBy = ["--not", "--branches", "--remotes", "--tags"]
  const total = Number((await git(["rev-list", "--count", "HEAD", ...heldBy], { cwd: directory, signal })).trim())
  if (total === 0) return { listed: [], total }
  const log = await git(
    ["log", "--no-show-signature", `--max-count=${MAX_LISTED_COMMITS}`, "--format=%H %s", "HEAD", ...heldBy],
    { cwd: directory, signal },
  )
  const listed = log
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(" ")
      return { sha: shortSha(line.slice(0, space)), subject: line.slice(space + 1) }
    })
  return { listed, total }
}

/**
 * Throws `dirty_tree` when `HEAD` of the detached working tree `directory` is
 * at commits nothing else holds, which the removal would leave without a name.
 * `details.commits` lists the first of them (short id and subject), and
 * `details.commits_total` counts them all.
 */
export async function requireNoUnheldCommits(directory: string, signal?: AbortSignal): Promise<void> {
  const { listed, total } = await unheldCommits(directory, signal)
  if (total === 0) return
  throw new ToolError(
    "dirty_tree",
    `HEAD is detached in ${directory} at ${total} ${total === 1 ? "commit" : "commits"} that no branch, remote branch or tag holds; removing the worktree would lose them with its reflog. Create a branch there for them first.`,
    { details: { commits: listed, commits_total: total } },
  )
}
