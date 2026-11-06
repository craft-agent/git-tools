import { execFileSync } from "node:child_process"
import { SetupError } from "./errors.mjs"
import { parseOrigin } from "./options.mjs"

function git(root, args) {
  return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] })
}

/** The GitHub `{ owner, repo }` of the `origin` remote, or `null` when there is none or it is not on GitHub. */
export function readOrigin(root) {
  try {
    return parseOrigin(git(root, ["remote", "get-url", "origin"]))
  } catch {
    return null
  }
}

/** Refuses unless `root` is the top of a git work tree with nothing uncommitted. */
export function assertCleanWorkTree(root) {
  let prefix
  try {
    prefix = git(root, ["rev-parse", "--show-prefix"]).trim()
  } catch {
    throw new SetupError("This is not a git work tree; run the setup in a clone of your repository.")
  }
  if (prefix !== "") throw new SetupError("Run the setup from the top of the repository.")
  if (git(root, ["status", "--porcelain"]).trim() !== "") {
    throw new SetupError("The working tree has uncommitted changes; commit or stash them first.")
  }
}

/** Every tracked file, relative to `root`. */
export function listTrackedFiles(root) {
  return git(root, ["ls-files", "-z"]).split("\0").filter(Boolean)
}
