import { dirname, join } from "node:path"
import { z } from "zod"
import { realpathOfExisting, realpathOrSelf } from "../paths"
import { branchName, listWorktrees, type ListedWorktree } from "../worktrees"
import { repositoryName } from "./layout"

const worktreeSchema = z.object({
  directory: z.string().describe("The worktree's directory: its real path when it exists, else as git prints it."),
  branch: z.string().nullable().describe("The checked-out branch's name; null when HEAD is detached or bare."),
  head: z.string().nullable().describe("The full sha of the commit checked out; null for a bare repository."),
  main: z.boolean().describe("Whether this is the main working tree."),
  current: z.boolean().describe("Whether this is the working tree the call was made from."),
  locked: z.boolean().describe("Whether the worktree is locked, so git will not prune or remove it."),
  lock_reason: z.string().nullable().describe("Why it is locked; null when it is not or no reason was given."),
  prunable: z.boolean().describe("Whether git can prune the worktree: its directory is gone."),
  in_layout: z
    .boolean()
    .describe("Whether the directory is where the layout puts a worktree: directly under <root>/<repository>."),
})

/** The worktrees of a repository, with the layout they are measured against. */
export const worktreeListSchema = z.object({
  root: z.string().describe("The worktree root the layout uses: the worktree_root setting, else ~/worktrees."),
  repository: z.string().describe("The repository's name in the layout, a folder under the root."),
  worktrees: z.array(worktreeSchema).describe("Every worktree of the repository, the main working tree first."),
})

type Listing = z.output<typeof worktreeListSchema>
type WorktreeView = Listing["worktrees"][number]

async function describeWorktree(entry: ListedWorktree, caller: string, layoutFolder: string): Promise<WorktreeView> {
  const directory = await realpathOrSelf(entry.path)
  return {
    directory,
    branch: branchName(entry.branch),
    head: entry.head,
    main: entry.main,
    current: directory === caller,
    locked: entry.locked !== null,
    lock_reason: entry.locked || null,
    prunable: entry.prunable !== null,
    in_layout: (await realpathOfExisting(dirname(entry.path))) === layoutFolder,
  }
}

/**
 * Lists the worktrees of the repository the working tree `callerRoot` belongs
 * to, from git alone. `root` is the worktree root of the layout; the layout
 * folder of the repository is `<root>/<repository>`, compared with each
 * directory's parent by real path where the paths exist.
 */
export async function readWorktreeList(callerRoot: string, root: string, signal?: AbortSignal): Promise<Listing> {
  const repository = await repositoryName(callerRoot, signal)
  const [caller, layoutFolder, entries] = await Promise.all([
    realpathOrSelf(callerRoot),
    realpathOfExisting(join(root, repository)),
    listWorktrees(callerRoot, signal),
  ])
  return {
    root,
    repository,
    worktrees: await Promise.all(entries.map((entry) => describeWorktree(entry, caller, layoutFolder))),
  }
}
