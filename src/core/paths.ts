import { realpath } from "node:fs/promises"
import { isAbsolute, relative, sep } from "node:path"

/** Whether `dir` is `root` or inside it, compared by real path; a path that cannot be resolved is not. */
export async function isWithin(dir: string, root: string): Promise<boolean> {
  try {
    const path = relative(await realpath(root), await realpath(dir))
    return path === "" || !(path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path))
  } catch {
    return false
  }
}
