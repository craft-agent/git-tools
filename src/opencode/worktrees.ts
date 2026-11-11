import { existsSync } from "node:fs"
import { basename } from "node:path"
import { isToolError, repositoryRoot, type ToolOptions, type ToolSpec } from "../core"
import { addWorktree, worktreeAdd } from "../core/worktree/add"
import { mainCheckout, worktreeRoot } from "../core/worktree/layout"
import { readWorktreeList } from "../core/worktree/list"
import { removeWorktree, worktreeRemove } from "../core/worktree/remove"
import { PROJECT } from "../project"
import type { PluginDeps } from "./shared"
import type { V2Context, V2OperationError, V2WorktreeDefinition, V2WorktreeEntry } from "./types"

/** The toolset whose tools place worktrees, and so the one that makes the plugin register a strategy. */
const WORKTREE_TOOLSET = worktreeAdd.toolset

/** The tools that add or remove a worktree, after which the harness's worktree inventory is stale. */
const WORKTREE_WRITE_IDS: ReadonlySet<string> = new Set([worktreeAdd.id, worktreeRemove.id])

/** The id of the strategy, which OpenCode files each worktree it places under. */
const STRATEGY_ID = `${PROJECT.name}.worktrees`

/** Where newer releases of the harness's plugin package export `Worktree.OperationError`. */
const PLUGIN_PACKAGE = "@opencode/plugin"

/** The tools' own `dirty_tree` for modified or untracked files lists them in `details.files`; the one for unheld commits does not. */
const FILES_DETAIL = "files"

/** Errors of `repositoryRoot` that mean the directory is no repository (to list) rather than a failure. */
const NOT_IN_REPOSITORY_CODES = ["not_a_repository", "not_found"]

/** The plugin package's force-required error class, or `undefined` when this release of the harness does not export it. */
async function importOperationError(): Promise<V2OperationError | undefined> {
  try {
    const plugin = (await import(PLUGIN_PACKAGE)) as { Worktree?: { OperationError?: V2OperationError } }
    return plugin.Worktree?.OperationError
  } catch {
    return undefined
  }
}

/** Whether `error` is the refusal of a worktree with modified, staged or untracked files, which a forced removal would discard. */
function isDirtyFilesRefusal(error: unknown): error is Error {
  return isToolError(error) && error.code === "dirty_tree" && error.details?.[FILES_DETAIL] !== undefined
}

/**
 * The worktree strategy of the plugin options, built on the tools' own
 * functions so OpenCode's worktrees follow the same layout and landed rule.
 * OpenCode suggests `<its folder>/<name>`: the name becomes the branch, and
 * its `branch` is the starting ref (V2's contract), not a branch name.
 */
export function worktreeStrategy(options: ToolOptions, deps: PluginDeps = {}): V2WorktreeDefinition {
  return {
    id: STRATEGY_ID,
    async create({ sourceDirectory, directory, branch }) {
      const { directory: created } = await addWorktree({
        callerRoot: await repositoryRoot({ cwd: sourceDirectory }),
        worktreeRoot: worktreeRoot({ options }),
        branch: basename(directory),
        from: branch,
      })
      return { directory: created }
    },
    async remove({ directory, force }) {
      if (!existsSync(directory)) return
      const callerRoot = await mainCheckout(directory)
      try {
        await removeWorktree({
          callerRoot,
          callerDirectory: callerRoot,
          worktreeRoot: worktreeRoot({ options }),
          directory,
          force,
        })
      } catch (error) {
        if (!isDirtyFilesRefusal(error)) throw error
        const OperationError = await (deps.worktreeOperationError ?? importOperationError)()
        if (OperationError === undefined) throw error
        throw new OperationError({ message: error.message, forceRequired: true })
      }
    },
    async list(sourceDirectory) {
      let callerRoot: string
      try {
        callerRoot = await repositoryRoot({ cwd: sourceDirectory })
      } catch (error) {
        if (isToolError(error) && NOT_IN_REPOSITORY_CODES.includes(error.code)) return []
        throw error
      }
      const { worktrees } = await readWorktreeList(callerRoot, worktreeRoot({ options }))
      return worktrees.flatMap((entry): V2WorktreeEntry[] => {
        if (entry.main) return [{ directory: entry.directory, type: "root" }]
        return entry.prunable || !entry.in_layout ? [] : [{ directory: entry.directory, type: "worktree" }]
      })
    },
  }
}

/**
 * Registers the worktree strategy when the selection holds a tool of the
 * worktree toolset that writes (so the toolset is on and the profile is not
 * read-only) and the harness has worktree strategies; else registers nothing.
 */
export async function registerWorktreeStrategy(
  ctx: V2Context,
  selected: { specs: ToolSpec[]; options: ToolOptions },
  deps: PluginDeps = {},
): Promise<void> {
  const writes = selected.specs.some((spec) => spec.toolset === WORKTREE_TOOLSET && spec.class !== "read")
  if (!writes || ctx.worktree?.transform === undefined) return
  const strategy = worktreeStrategy(selected.options, deps)
  await ctx.worktree.transform((editor) => editor.add(strategy))
}

/** Whether a successful run of `spec` adds or removes a worktree, so the harness's inventory needs a refresh. */
export function changesWorktrees(spec: Pick<ToolSpec, "id">): boolean {
  return WORKTREE_WRITE_IDS.has(spec.id)
}

/**
 * Asks the harness to refresh the worktree inventory of the project the
 * session belongs to. The tool's result stands whatever happens here, so
 * every failure is swallowed.
 */
export async function refreshWorktrees(ctx: V2Context, sessionID: string): Promise<void> {
  try {
    const { projectID } = await ctx.session.get({ sessionID })
    if (!projectID) return
    await ctx.worktree?.refresh?.({ projectID })
  } catch {
    // The worktree was added or removed; a stale inventory is the harness's to recover from.
  }
}
