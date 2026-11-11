import { git } from "./git"

const WORKTREE_PREFIX = "worktree "
const HEAD_PREFIX = "HEAD "
const BRANCH_PREFIX = "branch "
const DETACHED_KEYWORD = "detached"
const BARE_KEYWORD = "bare"
const LOCKED_KEYWORD = "locked"
const PRUNABLE_KEYWORD = "prunable"
const BLOCK_SEPARATOR = /\r?\n\s*\r?\n/
const LINE_SEPARATOR = /\r?\n/

/** The ref prefix of a local branch, which `git worktree list` prints in full. */
export const LOCAL_BRANCH_PREFIX = "refs/heads/"

/** One worktree of a repository, as `git worktree list --porcelain` describes it. */
export type ListedWorktree = {
  /** The directory, as git prints it. */
  path: string
  /** The full commit sha checked out, or null for a bare repository. */
  head: string | null
  /** The full ref checked out, such as `refs/heads/feat`; null when detached or bare. */
  branch: string | null
  bare: boolean
  detached: boolean
  /** Whether this is the main working tree, which git lists first. */
  main: boolean
  /** Why the worktree is locked (empty when no reason was given); null when it is not locked. */
  locked: string | null
  /** Why the worktree can be pruned (its directory is gone); null when it cannot. */
  prunable: string | null
}

/** The reason that follows a `locked` or `prunable` keyword: the rest of the line, empty when there is none. */
function reasonAfter(line: string, keyword: string): string | null {
  if (line === keyword) return ""
  return line.startsWith(`${keyword} `) ? line.slice(keyword.length + 1) : null
}

function parseBlock(block: string, main: boolean): ListedWorktree {
  const entry: ListedWorktree = {
    path: "",
    head: null,
    branch: null,
    bare: false,
    detached: false,
    main,
    locked: null,
    prunable: null,
  }
  for (const rawLine of block.split(LINE_SEPARATOR)) {
    const line = rawLine.trim()
    if (line.startsWith(WORKTREE_PREFIX)) entry.path = line.slice(WORKTREE_PREFIX.length)
    else if (line.startsWith(HEAD_PREFIX)) entry.head = line.slice(HEAD_PREFIX.length)
    else if (line.startsWith(BRANCH_PREFIX)) entry.branch = line.slice(BRANCH_PREFIX.length)
    else if (line === DETACHED_KEYWORD) entry.detached = true
    else if (line === BARE_KEYWORD) entry.bare = true
    entry.locked = reasonAfter(line, LOCKED_KEYWORD) ?? entry.locked
    entry.prunable = reasonAfter(line, PRUNABLE_KEYWORD) ?? entry.prunable
  }
  return entry
}

/** Parses the output of `git worktree list --porcelain`; the first entry is the main working tree. */
export function parseWorktreeList(porcelain: string): ListedWorktree[] {
  return porcelain
    .trim()
    .split(BLOCK_SEPARATOR)
    .filter(Boolean)
    .map((block, index) => parseBlock(block, index === 0))
}

/** The short name of a local branch ref (`refs/heads/feat` is `feat`); any other ref, or none, is returned as it is. */
export function branchName(ref: string | null): string | null {
  return ref?.startsWith(LOCAL_BRANCH_PREFIX) ? ref.slice(LOCAL_BRANCH_PREFIX.length) : ref
}

/** Every worktree of the repository `root` belongs to, the main working tree first. Reads git alone. */
export async function listWorktrees(root: string, signal?: AbortSignal): Promise<ListedWorktree[]> {
  const output = await git(["worktree", "list", "--porcelain"], { cwd: root, signal })
  return parseWorktreeList(output)
}
