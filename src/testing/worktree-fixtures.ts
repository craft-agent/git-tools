/**
 * Helpers for the tests of the worktree tools, on top of `tempRepo`: the
 * worktree root of a test, a context that uses it, and a second clone that
 * moves the remote.
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { git } from "../core/git"
import { invoke, type ToolContext } from "../core/tool"
import { worktreeAdd } from "../core/worktree/add"
import { WORKTREE_ROOT_OPTION } from "../core/worktree/layout"
import { worktreeRemove } from "../core/worktree/remove"
import type { TempRepo } from "./git-repo"

/** The repository name the layout gives a `tempRepo` with a remote: the folder of its bare `origin.git`. */
export const REMOTE_REPOSITORY = "origin"

/** The repository name the layout gives a `tempRepo` without a remote: the folder of its working tree. */
export const LOCAL_REPOSITORY = "work"

const OTHER_CLONE_FOLDER = "other-clone"

/** The folder the worktrees of a test go in, inside the repository's temporary home (so it is removed with it). */
export function worktreeRootOf(repo: TempRepo): string {
  return join(repo.home, "task-worktrees")
}

/** A context for the repository's working tree that sets `worktree_root` to the test's root. */
export function worktreeContext(repo: TempRepo, root = worktreeRootOf(repo)): ToolContext {
  return { cwd: repo.dir, options: { [WORKTREE_ROOT_OPTION]: root } }
}

/** The directory the layout gives `branch` under the test's root, for a repository named `repository`. */
export function layoutDirectory(repo: TempRepo, repository: string, branch: string): string {
  return join(worktreeRootOf(repo), repository, branch.replaceAll("/", "-"))
}

/** Adds a worktree for `branch` through the tool and returns its directory. */
export async function addTaskWorktree(repo: TempRepo, branch: string): Promise<string> {
  return (await invoke(worktreeAdd, { branch }, worktreeContext(repo))).directory
}

/** Removes the worktree at `directory` through the tool, called from the repository's working tree. */
export function removeIn(repo: TempRepo, directory: string) {
  return invoke(worktreeRemove, { directory }, worktreeContext(repo))
}

/** Whether the repository has a local branch `name`. */
export async function branchExists(repo: TempRepo, name: string): Promise<boolean> {
  return (await repo.git(["branch", "--list", name])).trim() !== ""
}

/** Writes `files` (path → content) in the working tree `directory`, commits them with `message` and returns the new commit. */
export async function commitIn(directory: string, message: string, files: Record<string, string>): Promise<string> {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(directory, path)), { recursive: true })
    writeFileSync(join(directory, path), content)
  }
  await git(["add", "-A"], { cwd: directory })
  await git(["commit", "-m", message], { cwd: directory })
  return (await git(["rev-parse", "HEAD"], { cwd: directory })).trim()
}

/** The full commit `ref` names in the repository. */
export async function revision(repo: TempRepo, ref: string): Promise<string> {
  return (await repo.git(["rev-parse", ref])).trim()
}

/** Commits an empty commit on `main` from a second clone of the remote and pushes it; returns the commit. The repository itself has not seen it. */
export async function pushFromAnotherClone(repo: TempRepo, message: string): Promise<string> {
  const clone = join(repo.home, OTHER_CLONE_FOLDER)
  if (!existsSync(clone)) await git(["clone", "--quiet", repo.remote!, clone], { cwd: repo.home })
  await git(["commit", "--allow-empty", "-m", message], { cwd: clone })
  await git(["push", "--quiet", "origin", "main"], { cwd: clone })
  return (await git(["rev-parse", "HEAD"], { cwd: clone })).trim()
}

/** Every local branch, every tag and every worktree of the repository, to compare before and after a call. */
export async function repositoryState(repo: TempRepo): Promise<string> {
  const refs = await repo.git(["for-each-ref", "--format=%(refname) %(objectname)", "refs/heads", "refs/tags"])
  return `${refs}${await repo.git(["worktree", "list", "--porcelain"])}`
}
