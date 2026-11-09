import { z } from "zod"
import { ToolError } from "../errors"
import { git } from "../git"
import { defineTool, type ToolContext } from "../tool"
import { workingTree } from "../tree"
import { parseNumstat } from "./commit-landed"
import { buildPatch, diffDigest, parseHunks, unstagedDiff } from "./hunks"

const input = z.object({
  digest: z.string().describe("The digest of the git_commit_read hunks listing the ids come from."),
  hunks: z
    .array(z.number().int().positive())
    .min(1)
    .describe("The ids of the hunks to stage, from that listing; a repeated id is staged once."),
  paths: z
    .array(z.string())
    .optional()
    .describe("The same files or directories the listing was made with, relative to the working tree root."),
})

type Args = z.output<typeof input>

const output = z.object({
  root: z.string().describe("The absolute path of the working tree root."),
  staged: z.array(z.number().int()).describe("The ids of the hunks that were staged, ascending."),
  files: z
    .array(
      z.object({
        file: z.string().describe("The path of the file, relative to the repository root."),
        added: z.number().int().describe("The lines added in the index against HEAD (0 for a binary file)."),
        removed: z.number().int().describe("The lines removed in the index against HEAD (0 for a binary file)."),
      }),
    )
    .describe("Every file the index now changes against HEAD, including what was staged before this call."),
})

async function stagedFiles(root: string, signal: AbortSignal | undefined): Promise<z.output<typeof output>["files"]> {
  return parseNumstat(await git(["diff", "--cached", "--numstat", "-z", "--no-renames"], { cwd: root, signal }))
}

/** Stages the hunks of a git_commit_read hunks listing that the call names. */
export const commitStage = defineTool({
  id: "git_commit_stage",
  title: "Stage chosen hunks",
  intent: "About to stage chosen hunks",
  description: [
    "Stage exactly the named hunks of a git_commit_read hunks listing into the index.",
    "Pass the listing's digest with the ids and the same paths: the call recomputes the diff and stages nothing when it differs from the listing, so a stale listing never stages other hunks.",
    "The working tree is untouched. Ids are positions in one listing, so list again after staging.",
    "A binary file cannot be staged by hunk; stage it whole with git add.",
  ].join(" "),
  toolset: "commit",
  class: "idempotent",
  openWorld: false,
  targets: async (_args: Args, ctx: ToolContext) => [await workingTree(ctx)],
  input,
  output,
  async execute(args: Args, ctx: ToolContext) {
    const root = await workingTree(ctx)
    const diff = await unstagedDiff(root, args.paths, ctx.signal)
    if (diffDigest(diff) !== args.digest) {
      throw new ToolError(
        "stale",
        "The unstaged changes differ from that listing (different paths, or files changed or staged since); list the hunks again and use its ids and digest.",
      )
    }
    const hunks = parseHunks(diff)
    const ids = [...new Set(args.hunks)].sort((a, b) => a - b)
    const unknown = ids.filter((id) => id > hunks.length)
    if (unknown.length > 0) {
      throw new ToolError(
        "invalid_argument",
        `Unknown hunk id(s): ${unknown.join(", ")}; the listing has ${hunks.length}. List the hunks again and use its ids.`,
      )
    }
    const selected = ids.map((id) => hunks[id - 1]!)
    const binary = selected.filter((hunk) => hunk.binary)
    if (binary.length > 0) {
      throw new ToolError(
        "invalid_argument",
        `Hunk(s) ${binary.map((hunk) => hunk.id).join(", ")} (${binary.map((hunk) => hunk.file).join(", ")}) is a binary file; stage it whole with git add.`,
      )
    }
    await git(["apply", "--cached", "--recount", "--whitespace=nowarn", "-"], {
      cwd: root,
      signal: ctx.signal,
      stdin: buildPatch(selected),
    })
    return { root, staged: ids, files: await stagedFiles(root, ctx.signal) }
  },
})
