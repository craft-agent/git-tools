import { z } from "zod"
import { git } from "../git"

const NUMSTAT_PATTERN = /^(\d+|-)\t(\d+|-)\t([\s\S]*)$/
const RENAME_OR_COPY = new Set(["R", "C"])

/** One file a commit changed, with its line counts; a binary file counts as 0. */
export const landedFileSchema = z.object({
  file: z.string().describe("The path of the file, relative to the repository root; the new path of a rename."),
  added: z.number().int().describe("The lines added; 0 for a binary file."),
  removed: z.number().int().describe("The lines removed; 0 for a binary file."),
})

/** What is left uncommitted. */
export const remainingSchema = z.object({
  staged: z.number().int().describe("The files with staged changes."),
  unstaged: z.number().int().describe("The files with changes that are not staged."),
  untracked: z.number().int().describe("The files git does not track."),
})

type LandedFile = z.output<typeof landedFileSchema>
type Remaining = z.output<typeof remainingSchema>

/** The files named by a NUL-separated `git ... -z` listing. */
export function splitNames(output: string): string[] {
  return output.split("\0").filter(Boolean)
}

/** Parses `git show` or `git diff` `--numstat -z`: a rename is `added removed TAB NUL old NUL new NUL`. */
export function parseNumstat(output: string): LandedFile[] {
  const tokens = output.split("\0")
  const files: LandedFile[] = []
  for (let index = 0; index < tokens.length; index++) {
    const match = NUMSTAT_PATTERN.exec(tokens[index]!.replace(/^\n+/, ""))
    if (!match) continue
    const [, added, removed, path] = match
    let file = path!
    if (file === "") {
      file = tokens[index + 2] ?? ""
      index += 2
    }
    files.push({ file, added: Number(added) || 0, removed: Number(removed) || 0 })
  }
  return files
}

/** Counts the entries of `git status --porcelain=v1 -z`; a rename or copy is followed by its original path. */
export function countRemaining(porcelain: string): Remaining {
  const remaining = { staged: 0, unstaged: 0, untracked: 0 }
  const tokens = porcelain.split("\0")
  for (let index = 0; index < tokens.length; index++) {
    const entry = tokens[index]!
    if (entry.length < 3) continue
    const [x, y] = [entry[0]!, entry[1]!]
    if (x === "?" && y === "?") {
      remaining.untracked++
      continue
    }
    if (x !== " ") remaining.staged++
    if (y !== " ") remaining.unstaged++
    if (RENAME_OR_COPY.has(x) || RENAME_OR_COPY.has(y)) index++
  }
  return remaining
}

/** The files HEAD changed. */
export async function landedFiles(root: string): Promise<LandedFile[]> {
  return parseNumstat(await git(["show", "--numstat", "-z", "--format=", "HEAD"], { cwd: root }))
}

/** What the working tree still holds uncommitted. */
export async function remainingChanges(root: string): Promise<Remaining> {
  return countRemaining(await git(["status", "--porcelain=v1", "-z"], { cwd: root }))
}
