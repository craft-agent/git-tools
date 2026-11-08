import { z } from "zod"
import { ToolError } from "../errors"
import { git, gitResult, type GitOptions } from "../git"

const SHA_PATTERN = /^[0-9a-f]{4,64}$/i
const ZERO_SHA_PATTERN = /^0+$/
const LINES_PATTERN = /^\d+(,[+-]?\d+)?$/

/** What `origin` starts from: a commit, a blamed line range, or a pickaxe search optionally scoped to a file. */
export type OriginAnchor = { sha?: string; file?: string; lines?: string; token?: string; regex?: string }

/** The result of `origin`. */
export const originSchema = z.object({
  commit: z
    .object({
      sha: z.string().describe("The full commit sha."),
      subject: z.string().describe("The commit subject."),
      message: z.string().describe("The full commit message, with trailing newlines trimmed."),
      author: z.string().describe("The commit author's name."),
      author_email: z.string().describe("The commit author's email address."),
      date: z.string().describe("The author date in strict ISO 8601 format."),
    })
    .describe("The commit the change came from."),
  located_by: z.string().describe("The sha, blame range or pickaxe search used to locate the commit."),
  pickaxe: z
    .object({
      hits: z.number().int().describe("The number of commits adding or removing the searched content."),
      newest: z.string().describe("The full sha of the newest hit."),
      oldest: z.string().describe("The full sha of the oldest hit, returned as the origin commit."),
    })
    .nullable()
    .describe("Pickaxe hit counts and endpoints, or null for sha and blame anchors."),
})

function validateAnchor(anchor: OriginAnchor): void {
  const { sha, file, lines, token, regex } = anchor
  const hasSha = sha !== undefined
  const hasFile = file !== undefined
  const hasLines = lines !== undefined
  const hasToken = token !== undefined
  const hasRegex = regex !== undefined
  if (
    (hasSha && (hasFile || hasLines || hasToken || hasRegex)) ||
    (hasLines && (!hasFile || hasToken || hasRegex)) ||
    (hasToken && hasRegex) ||
    (!hasSha && !hasLines && !hasToken && !hasRegex)
  ) {
    throw new ToolError(
      "invalid_argument",
      "Pass exactly one of sha, file with lines, token, or regex; file may also scope token or regex.",
    )
  }
  if (sha !== undefined && !SHA_PATTERN.test(sha)) {
    throw new ToolError("invalid_argument", "Pass sha as 4 to 64 hexadecimal characters naming a commit.")
  }
  if (sha !== undefined && ZERO_SHA_PATTERN.test(sha)) {
    throw new ToolError(
      "invalid_argument",
      "An all-zero sha stands for uncommitted changes; there is no commit to trace. Pass a committed sha instead.",
    )
  }
  if (lines !== undefined && !LINES_PATTERN.test(lines)) {
    throw new ToolError("invalid_argument", 'Pass lines as a blame range such as "10,20" or "10,+5", with file.')
  }
}

type LocatedOrigin = Pick<z.output<typeof originSchema>, "located_by" | "pickaxe"> & { sha: string }

async function locateSha(sha: string, options: GitOptions): Promise<LocatedOrigin> {
  const resolved = await gitResult(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`], options)
  if (resolved.code !== 0) {
    throw new ToolError("not_found", `${sha} is not a commit in this clone; fetch it, or trace it where it lives.`)
  }
  return { sha: resolved.stdout.trim(), located_by: "sha", pickaxe: null }
}

async function locateBlame(file: string, lines: string, options: GitOptions): Promise<LocatedOrigin> {
  const resolved = await gitResult(["rev-parse", "--verify", "--quiet", `HEAD:${file}`], options)
  if (resolved.code !== 0) {
    throw new ToolError("not_found", `${file} is not in HEAD; only committed lines have an origin.`)
  }
  const blame = await git(["blame", "-w", "-C", "-L", lines, "--porcelain", "--", file], options)
  const sha = blame.split("\n")[0].split(" ")[0]
  if (ZERO_SHA_PATTERN.test(sha)) {
    throw new ToolError(
      "not_found",
      `${file}:${lines} starts with a line that is not committed yet; it has no origin to trace.`,
    )
  }
  return { sha, located_by: `blame ${file}:${lines}`, pickaxe: null }
}

async function locatePickaxe(anchor: OriginAnchor, options: GitOptions): Promise<LocatedOrigin> {
  const flag = anchor.token !== undefined ? "-S" : "-G"
  const what = anchor.token ?? anchor.regex!
  // Joined to its flag, so a string that starts with "-" is never read as an option.
  const args = ["log", `${flag}${what}`, "--format=%H"]
  if (anchor.file !== undefined) args.push("--", anchor.file)
  const hits = (await git(args, options)).split("\n").filter(Boolean)
  if (!hits.length) {
    throw new ToolError("not_found", `No commit in HEAD's history adds or removes ${what}.`)
  }
  const sha = hits[hits.length - 1]
  return {
    sha,
    located_by: `pickaxe ${flag} "${what}"${anchor.file !== undefined ? ` in ${anchor.file}` : ""}`,
    pickaxe: { hits: hits.length, newest: hits[0], oldest: sha },
  }
}

/**
 * The commit a change came from, with its full message. Blame returns the
 * commit of the range's first line; a pickaxe search returns its oldest hit,
 * the commit that introduced the string. Throws `invalid_argument` for an
 * anchor that is not exactly one of the kinds, and `not_found` when nothing
 * committed matches.
 */
export async function readOrigin(
  root: string,
  anchor: OriginAnchor,
  signal?: AbortSignal,
): Promise<z.output<typeof originSchema>> {
  validateAnchor(anchor)
  const options = { cwd: root, signal }
  const { sha, located_by, pickaxe } =
    anchor.sha !== undefined
      ? await locateSha(anchor.sha, options)
      : anchor.file !== undefined && anchor.lines !== undefined
        ? await locateBlame(anchor.file, anchor.lines, options)
        : await locatePickaxe(anchor, options)
  const output = await git(["show", "-s", "--format=%H%x00%s%x00%an%x00%ae%x00%aI%x00%B", sha], options)
  const [fullSha, subject, author, author_email, date, message] = output.split("\0")
  return {
    commit: { sha: fullSha, subject, message: message.replace(/\n+$/, ""), author, author_email, date },
    located_by,
    pickaxe,
  }
}
