import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { gitPath } from "../tree"

/** Where git keeps the local branches. */
export const HEADS_PREFIX = "refs/heads/"

/** The directories git keeps a rebase's state in: the merge backend, then the apply backend. */
const STATE_DIRS = ["rebase-merge", "rebase-apply"]

/** The lines of `rebase-merge/update-refs` for one branch: its ref name, its old id and its new id (or a placeholder). */
const UPDATE_REFS_LINES = 3

/** A layer branch and the full id of its tip. */
export type LayerTip = { branch: string; sha: string }

/** The state of a rebase in progress. */
export type RebaseState = {
  /** The branch the rebase runs on. */
  top: string
  /** The branches it moves, bottom to top, with their tips before; the top comes last. */
  before: LayerTip[]
  /** The full id of the commit it goes onto. */
  onto: string | null
}

async function readStateFile(dir: string, name: string): Promise<string | undefined> {
  try {
    return (await readFile(join(dir, name), "utf8")).trim()
  } catch {
    return undefined
  }
}

/** The branches `rebase-merge/update-refs` lists, with the tips they had before, in the order git wrote them. */
function parseUpdateRefs(text: string): LayerTip[] {
  const lines = text.split("\n").filter(Boolean)
  const tips: LayerTip[] = []
  for (let i = 0; i + UPDATE_REFS_LINES <= lines.length; i += UPDATE_REFS_LINES) {
    const [ref = "", sha = ""] = lines.slice(i, i + UPDATE_REFS_LINES)
    if (ref.startsWith(HEADS_PREFIX)) tips.push({ branch: ref.slice(HEADS_PREFIX.length), sha })
  }
  return tips
}

/**
 * Reads the rebase in progress from git's state directory: the branch it runs
 * on, every branch it moves (`--update-refs`, git 2.38) with its tip before,
 * and what it goes onto. Null when no rebase left a state to read.
 */
export async function readRebaseState(root: string, signal?: AbortSignal): Promise<RebaseState | null> {
  for (const name of STATE_DIRS) {
    const dir = await gitPath(root, name, signal)
    const head = await readStateFile(dir, "head-name")
    const origHead = await readStateFile(dir, "orig-head")
    if (!head?.startsWith(HEADS_PREFIX) || !origHead) continue

    const top = head.slice(HEADS_PREFIX.length)
    const updated = parseUpdateRefs((await readStateFile(dir, "update-refs")) ?? "")
    return {
      top,
      before: [...updated.filter((tip) => tip.branch !== top), { branch: top, sha: origHead }],
      onto: (await readStateFile(dir, "onto")) || null,
    }
  }
  return null
}
