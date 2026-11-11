import { realpath } from "node:fs/promises"
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path"

/** The real path of `path`, else `path` itself when it cannot be resolved (it does not exist). */
export async function realpathOrSelf(path: string): Promise<string> {
  try {
    return await realpath(path)
  } catch {
    return path
  }
}

/**
 * The path with the nearest part that exists resolved to its real path, and
 * the rest (which does not exist yet or any more) kept as written; so a path
 * under a symlinked folder compares equal to the same path spelled by its
 * real folder, whether or not it exists.
 */
export async function realpathOfExisting(path: string): Promise<string> {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(await realpath(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

/** Whether `dir` is `root` or inside it, compared by real path; a path that cannot be resolved is not. */
export async function isWithin(dir: string, root: string): Promise<boolean> {
  try {
    const path = relative(await realpath(root), await realpath(dir))
    return path === "" || !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
  } catch {
    return false
  }
}
