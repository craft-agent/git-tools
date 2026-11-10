/**
 * Fixtures for the push tools' tests: a preview call, more remotes, a second
 * clone that pushes the way another person would, and an `origin` that looks
 * like GitHub to the tools while staying a local repository.
 */

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { git, gitResult } from "../core/git"
import type { PreviewArgs } from "../core/push/preview"
import { pushRead } from "../core/push/read"
import { shortSha } from "../core/rewrite"
import { invoke, type ToolOptions } from "../core/tool"
import type { TempRepo } from "./git-repo"

/** The directory, beside the working tree, where the second clone lives. */
const PUSHER_CLONE = "pusher-clone"

/** A path that `githubRepo` reads as the repository `o/r` on GitHub; git reads it as a directory relative to the working tree. */
const GITHUB_LOOKALIKE = "github.com/o/r.git"

/** Previews a push of the repository's current line, or of what `args` name. */
export function previewOf(repo: TempRepo, args: PreviewArgs = {}, options?: ToolOptions) {
  return invoke(pushRead, { method: "preview", ...args }, { cwd: repo.dir, options })
}

/** The full id of `rev`. */
export async function fullSha(repo: TempRepo, rev: string): Promise<string> {
  return (await repo.git(["rev-parse", rev])).trim()
}

/** The short id of `rev`, as a preview shows it. */
export async function shortOf(repo: TempRepo, rev: string): Promise<string> {
  return shortSha(await fullSha(repo, rev))
}

/** Adds an empty bare repository as the remote `name`, beside the working tree. */
export async function addRemote(repo: TempRepo, name: string): Promise<string> {
  const dir = join(dirname(repo.dir), `${name}.git`)
  mkdirSync(dir, { recursive: true })
  await git(["init", "--bare"], { cwd: dir })
  await repo.git(["remote", "add", name, dir])
  return dir
}

/** Commits `files` on `branch` of origin in a second clone and pushes them, so the remote branch moves without this clone knowing. */
export async function pushFromOtherClone(
  repo: TempRepo,
  branch: string,
  message: string,
  files: Record<string, string>,
): Promise<string> {
  const other = join(dirname(repo.dir), PUSHER_CLONE)
  rmSync(other, { recursive: true, force: true })
  await git(["clone", "--quiet", repo.remote!, other], { cwd: dirname(repo.dir) })
  await git(["switch", "--quiet", branch], { cwd: other })
  for (const [path, content] of Object.entries(files)) writeFileSync(join(other, path), content)
  await git(["add", "-A"], { cwd: other })
  await git(["commit", "--quiet", "-m", message], { cwd: other })
  await git(["push", "--quiet", "origin", branch], { cwd: other })
  return (await git(["rev-parse", "HEAD"], { cwd: other })).trim()
}

/**
 * Points `origin` at a copy of itself whose URL reads as a repository on
 * GitHub, so the tools ask GitHub (the fake `gh`) about its branches while
 * every git call still works on a local repository. The copy is kept out of
 * the working tree's commits.
 */
export async function asGithubRemote(repo: TempRepo): Promise<void> {
  await git(["clone", "--quiet", "--bare", repo.remote!, join(repo.dir, GITHUB_LOOKALIKE)], { cwd: repo.dir })
  const exclude = (await repo.git(["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"])).trim()
  appendFileSync(exclude, "github.com/\n")
  await repo.git(["config", "remote.origin.url", GITHUB_LOOKALIKE])
  const url = await gitResult(["remote", "get-url", "origin"], { cwd: repo.dir })
  if (url.stdout.trim() !== GITHUB_LOOKALIKE) throw new Error(`origin reads as ${url.stdout.trim()}, not the lookalike`)
}
