/**
 * Fixtures for the rebase tools' tests: stacks of layer branches, a second
 * clone that moves `origin/main` the way another person would, and a rebase
 * stopped on a conflict.
 */

import { mkdirSync, rmSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { git } from "../core/git"
import { rebaseStart } from "../core/rebase/start"
import { invoke } from "../core/tool"
import type { TempRepo } from "./git-repo"

/** The directory, beside the working tree, where the second clone lives. */
const OTHER_CLONE = "other-clone"

/** The file the conflict fixtures change on both sides. */
export const CONFLICT_FILE = "README.md"

/** Cuts `name` from the current branch and gives it `count` commits of its own, each adding a file `<name>-<n>.txt`. */
export async function layer(repo: TempRepo, name: string, count = 1): Promise<void> {
  await repo.git(["switch", "-c", name])
  for (let i = 1; i <= count; i++) await repo.commit(`${name}: ${i}`, { [`${name}-${i}.txt`]: `${i}\n` })
}

/** Commits `files` on `main` in a second clone of origin and pushes them, so `origin/main` moves without this clone knowing. */
export async function pushToMain(repo: TempRepo, message: string, files: Record<string, string>): Promise<void> {
  const other = join(dirname(repo.dir), OTHER_CLONE)
  rmSync(other, { recursive: true, force: true })
  await git(["clone", "--quiet", repo.remote!, other], { cwd: dirname(repo.dir) })
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(other, path)), { recursive: true })
    writeFileSync(join(other, path), content)
  }
  await git(["add", "-A"], { cwd: other })
  await git(["commit", "--quiet", "-m", message], { cwd: other })
  await git(["push", "--quiet", "origin", "main"], { cwd: other })
}

/**
 * A stack `l1`, `l2`, `l3` of one commit each, checked out on `l3`, whose `l2`
 * commit changes `CONFLICT_FILE`, and an `origin/main` that changed it
 * differently, already fetched. Starting a rebase on it stops on `l2`'s commit
 * with `l1` already moved.
 */
export async function conflictingStack(repo: TempRepo): Promise<{ before: Record<string, string> }> {
  await layer(repo, "l1")
  await repo.git(["switch", "-c", "l2"])
  await repo.commit("l2: change the readme", { [CONFLICT_FILE]: "# Test\nl2 line\n" })
  await layer(repo, "l3")
  await pushToMain(repo, "main: change the readme", { [CONFLICT_FILE]: "# Test\nmain line\n" })
  await repo.git(["fetch", "origin", "main"])
  const before: Record<string, string> = {}
  for (const name of ["l1", "l2", "l3"]) before[name] = (await repo.git(["rev-parse", name])).trim()
  return { before }
}

/** Starts the rebase of the whole stack onto the fetched default branch, which stops on a conflict. */
export async function startStoppedRebase(repo: TempRepo) {
  const result = await invoke(rebaseStart, {}, { cwd: repo.dir })
  if (result.status !== "paused") throw new Error(`The fixture rebase did not stop: ${result.status}`)
  return result
}
