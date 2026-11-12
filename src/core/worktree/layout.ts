import { homedir } from "node:os"
import { basename, dirname, isAbsolute, join } from "node:path"
import { ToolError } from "../errors"
import { git, gitResult } from "../git"
import type { ToolContext } from "../tool"

/** The name of the `worktree_root` option, which says where task worktrees go. */
export const WORKTREE_ROOT_OPTION = "worktree_root"

/** The folder under the home directory that holds the worktrees when `worktree_root` is not set. */
const DEFAULT_ROOT_FOLDER = "worktrees"

const GIT_DIRECTORY = ".git"
const GIT_SUFFIX = /\.git$/
const URL_SEPARATOR = /[/:]/
const TRAILING_SLASHES = /\/+$/
const NOT_A_NAME = [".", ".."]

/**
 * Where task worktrees go: the `worktree_root` option, `~/worktrees` when it
 * is not set. The option arrives absolute and normalized. Nothing is created.
 * A value that is not an absolute path is `invalid_argument` naming the setting.
 */
export function worktreeRoot(ctx: Pick<ToolContext, "options">): string {
  const option = ctx.options?.[WORKTREE_ROOT_OPTION]
  const value = typeof option === "string" ? option.trim() : undefined
  if (!value) return join(process.env.HOME?.trim() || homedir(), DEFAULT_ROOT_FOLDER)
  if (!isAbsolute(value)) {
    throw new ToolError(
      "invalid_argument",
      `The ${WORKTREE_ROOT_OPTION} setting (${value}): the value must be an absolute path.`,
    )
  }
  return value
}

/**
 * The main checkout of the repository `root` belongs to: the folder that holds
 * its `.git` directory. A repository with no such folder (a bare one, or one
 * whose git directory is kept elsewhere) is its common git directory itself.
 */
export async function mainCheckout(root: string, signal?: AbortSignal): Promise<string> {
  const common = (await git(["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd: root, signal })).trim()
  return basename(common) === GIT_DIRECTORY ? dirname(common) : common
}

/** The last part of a remote URL (`https://host/o/r.git`, `git@host:o/r.git`, `/srv/r/`) without `.git`; empty when there is none. */
function nameInUrl(url: string): string {
  const name = url.trim().replace(TRAILING_SLASHES, "").split(URL_SEPARATOR).pop()?.replace(GIT_SUFFIX, "") ?? ""
  return NOT_A_NAME.includes(name) ? "" : name
}

/**
 * The repository's name in the layout: the last part of `origin`'s URL without
 * `.git`, else the folder name of the main checkout.
 */
export async function repositoryName(root: string, signal?: AbortSignal): Promise<string> {
  const origin = await gitResult(["remote", "get-url", "origin"], { cwd: root, signal })
  const fromUrl = origin.code === 0 ? nameInUrl(origin.stdout) : ""
  return fromUrl || basename(await mainCheckout(root, signal)).replace(GIT_SUFFIX, "")
}

/** Where the worktree of `branch` goes: `<root>/<repository>/<branch>`, with each `/` of the branch written `-`. */
export function worktreePath(root: string, repository: string, branch: string): string {
  return join(root, repository, branch.replaceAll("/", "-"))
}
