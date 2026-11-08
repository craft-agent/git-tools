import { readFile } from "node:fs/promises"
import { basename, join } from "node:path"
import { z } from "zod"
import { git, gitResult } from "./git"
import { operationInProgress, type Operation } from "./tree"

const REGION_MAX = 20
const SIDE_LINES_MAX = 40

const LOCKFILES: Record<string, string> = {
  "pnpm-lock.yaml": "pnpm install --lockfile-only",
  "package-lock.json": "npm install --package-lock-only",
  "npm-shrinkwrap.json": "npm install --package-lock-only",
  "yarn.lock": "yarn install",
  "bun.lock": "bun install",
  "bun.lockb": "bun install",
  "Cargo.lock": "cargo update --workspace",
  "uv.lock": "uv lock",
  "poetry.lock": "poetry lock --no-update",
  "go.sum": "go mod tidy",
  "Gemfile.lock": "bundle lock",
  "composer.lock": "composer update --lock",
}

const KINDS: Record<string, string> = {
  UU: "both modified",
  AA: "both added",
  DD: "both deleted",
  AU: "added by us",
  UA: "added by them",
  DU: "deleted by us",
  UD: "deleted by them",
}

const THEIRS_REFS: Partial<Record<Operation, string>> = {
  merge: "MERGE_HEAD",
  rebase: "REBASE_HEAD",
  "cherry-pick": "CHERRY_PICK_HEAD",
  revert: "REVERT_HEAD",
}

const regionSchema = z.object({
  line: z.number().int().describe("The 1-based line number of the opening conflict marker."),
  ours: z.array(z.string()).describe(`Lines from our side, at most ${SIDE_LINES_MAX}.`),
  base: z
    .array(z.string())
    .optional()
    .describe(`Diff3 common ancestor lines, at most ${SIDE_LINES_MAX}, when present.`),
  theirs: z.array(z.string()).describe(`Lines from their side, at most ${SIDE_LINES_MAX}.`),
  truncated: z.boolean().describe(`Whether any side had more than ${SIDE_LINES_MAX} lines.`),
})

const sideSchema = z.object({
  ref: z.string().describe("The ref identifying this side of the operation."),
  sha: z.string().describe("The full commit sha of this side."),
  subject: z.string().describe("The commit subject of this side."),
})

/** The operation's sides and the conflicted files with their marker regions or regeneration advice. */
export const conflictMapSchema = z.object({
  operation: z
    .enum(["rebase", "am", "merge", "cherry-pick", "revert", "bisect"] satisfies Operation[])
    .nullable()
    .describe("The operation in progress, or null when idle."),
  sides: z
    .object({
      ours: sideSchema.nullable().describe("Our side (HEAD), or null when unborn or unavailable."),
      theirs: sideSchema.nullable().describe("The operation's incoming commit, or null when unavailable."),
      note: z.string().describe("What ours and theirs mean for this operation."),
    })
    .describe("The commits on each side and their meaning in this operation."),
  count: z.number().int().describe("The number of conflicted files after the paths filter."),
  files: z
    .array(
      z.object({
        path: z.string().describe("The conflicted file path relative to the working tree root."),
        kind: z.string().describe("What each side did to the file, or the raw porcelain XY code."),
        lockfile: z.boolean().describe("Whether this is a known lockfile to regenerate instead of merging by hand."),
        regenerate: z.string().optional().describe("For a lockfile, the command that regenerates it."),
        resolve: z.string().optional().describe("For a lockfile, advice on keeping one side and regenerating it."),
        binary: z.boolean().optional().describe("True when a non-lockfile contains a NUL byte."),
        region_count: z.number().int().optional().describe("The total number of complete conflict-marker regions."),
        regions: z.array(regionSchema).optional().describe(`At most ${REGION_MAX} complete conflict-marker regions.`),
        regions_truncated: z.boolean().optional().describe(`Whether more than ${REGION_MAX} regions were found.`),
      }),
    )
    .describe("Conflicted files matching the requested paths."),
})

type ConflictMap = z.output<typeof conflictMapSchema>
type Region = z.output<typeof regionSchema>
type ConflictFile = ConflictMap["files"][number]

/** Parses complete conflict-marker regions, retaining at most 40 lines per side. */
export function parseRegions(text: string): Region[] {
  const regions: Region[] = []
  const lines = text.split("\n")
  let current: Region | null = null
  let side: "ours" | "base" | "theirs" = "ours"
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line.startsWith("<<<<<<<")) {
      current = { line: i + 1, ours: [], theirs: [], truncated: false }
      side = "ours"
    } else if (current && line.startsWith("|||||||")) {
      current.base = []
      side = "base"
    } else if (current && line.startsWith("=======")) {
      side = "theirs"
    } else if (current && line.startsWith(">>>>>>>")) {
      regions.push(current)
      current = null
    } else if (current) {
      const content = current[side]!
      if (content.length < SIDE_LINES_MAX) content.push(line)
      else current.truncated = true
    }
  }
  return regions
}

async function readSide(root: string, ref: string, signal?: AbortSignal): Promise<ConflictMap["sides"]["ours"]> {
  const result = await gitResult(["log", "-1", "--format=%H%x00%s", ref], { cwd: root, signal })
  if (result.code !== 0) return null
  const output = result.stdout.replace(/\n$/, "")
  const nul = output.indexOf("\0")
  return { ref, sha: output.slice(0, nul), subject: output.slice(nul + 1) }
}

async function readConflictFile(
  root: string,
  path: string,
  xy: string,
  operation: Operation | null,
): Promise<ConflictFile> {
  const file = { path, kind: KINDS[xy] ?? xy, lockfile: false }
  const regenerate = Object.hasOwn(LOCKFILES, basename(path)) ? LOCKFILES[basename(path)] : undefined
  if (regenerate) {
    return {
      ...file,
      lockfile: true,
      regenerate,
      resolve: `Resolve its manifest first, keep one side (\`git checkout --ours -- ${path}\` keeps ${operation === "rebase" ? "the branch being rebased onto" : "the current branch"}), run \`${regenerate}\` where the lockfile lives, then \`git add ${path}\`.`,
    }
  }
  let text: string
  try {
    text = await readFile(join(root, path), "utf8")
  } catch {
    return { ...file, region_count: 0, regions: [] }
  }
  if (text.includes("\0")) return { ...file, binary: true, region_count: 0, regions: [] }
  const regions = parseRegions(text)
  return {
    ...file,
    region_count: regions.length,
    regions: regions.slice(0, REGION_MAX),
    regions_truncated: regions.length > REGION_MAX,
  }
}

/** Reads the conflicts an operation left, optionally restricted to exact repository-relative paths. */
export async function readConflictMap(
  root: string,
  paths: string[] | undefined,
  signal?: AbortSignal,
): Promise<ConflictMap> {
  const operation = await operationInProgress(root, signal)
  const status = await git(["--no-optional-locks", "status", "--porcelain=v2", "-z"], { cwd: root, signal })
  const files: ConflictFile[] = []
  const records = status.split("\0")
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (record.startsWith("2 ")) {
      i++
      continue
    }
    if (!record.startsWith("u ")) continue
    const parts = record.split(" ")
    const path = parts.slice(10).join(" ")
    if (paths?.length && !paths.includes(path)) continue
    files.push(await readConflictFile(root, path, parts[1]!, operation))
  }
  const theirsRef = operation ? THEIRS_REFS[operation] : undefined
  return {
    operation,
    sides: {
      ours: await readSide(root, "HEAD", signal),
      theirs: theirsRef ? await readSide(root, theirsRef, signal) : null,
      note:
        operation === "rebase"
          ? "In a rebase, ours is the branch being rebased onto and theirs is the commit being replayed."
          : operation === "revert"
            ? "In a revert, theirs is the commit being reverted; its inverse is what is being applied."
            : "ours is the current branch (HEAD); theirs is what is being brought in.",
    },
    count: files.length,
    files,
  }
}
