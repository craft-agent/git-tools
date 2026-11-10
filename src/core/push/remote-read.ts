import { ToolError, isToolError } from "../errors"
import { git, gitResult } from "../git"
import { REMOTE_REFS_PREFIX } from "../rewrite"
import { HEADS_REF } from "../stack"

/** How long the read of the remote may take. */
export const LS_REMOTE_TIMEOUT_MS = 30_000

/** The line `git ls-remote --symref` prints for the branch the remote's `HEAD` names. */
const HEAD_SYMREF_PATTERN = new RegExp(`^ref: ${HEADS_REF}/(.+)\\tHEAD$`)

/** What the remote holds now. */
export type RemoteHeads = {
  /** The full commit id of each asked-for branch the remote has, by branch name. */
  heads: Map<string, string>
  /** The remote's default branch; null when neither the remote nor this repository's record of it says. */
  defaultBranch: string | null
}

/** The default branch this repository recorded for `remote` (`refs/remotes/<remote>/HEAD`), or null. */
async function recordedDefaultBranch(root: string, remote: string, signal?: AbortSignal): Promise<string | null> {
  const head = await gitResult(["symbolic-ref", "--quiet", "--short", `${REMOTE_REFS_PREFIX}${remote}/HEAD`], {
    cwd: root,
    signal,
  })
  const target = head.code === 0 ? head.stdout.trim() : ""
  return target.startsWith(`${remote}/`) ? target.slice(remote.length + 1) : null
}

/**
 * Reads the remote's `branches` and its default branch live, with one
 * `git ls-remote --symref`. A failure keeps the runner's code and names the
 * remote. The default branch falls back to the one this repository recorded
 * when the remote does not say.
 */
export async function readRemote(
  root: string,
  remote: string,
  branches: string[],
  signal?: AbortSignal,
): Promise<RemoteHeads> {
  let output: string
  try {
    output = await git(["ls-remote", "--symref", remote, "HEAD", ...branches.map((name) => `${HEADS_REF}/${name}`)], {
      cwd: root,
      signal,
      timeoutMs: LS_REMOTE_TIMEOUT_MS,
    })
  } catch (error) {
    if (!isToolError(error)) throw error
    throw new ToolError(error.code, `Could not read ${remote}: ${error.message}`, { cause: error })
  }

  const asked = new Set(branches)
  const heads = new Map<string, string>()
  let defaultBranch: string | null = null
  for (const line of output.split("\n")) {
    const symref = HEAD_SYMREF_PATTERN.exec(line)
    if (symref) {
      defaultBranch = symref[1]!
      continue
    }
    const [sha = "", ref = ""] = line.split("\t")
    const name = ref.startsWith(`${HEADS_REF}/`) ? ref.slice(HEADS_REF.length + 1) : undefined
    // A pattern also matches the tail of a longer ref name; only the exact branch counts.
    if (name !== undefined && asked.has(name)) heads.set(name, sha)
  }
  return { heads, defaultBranch: defaultBranch ?? (await recordedDefaultBranch(root, remote, signal)) }
}
