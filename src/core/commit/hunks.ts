import { createHash } from "node:crypto"
import { isAbsolute, relative, resolve, sep } from "node:path"
import { z } from "zod"
import { ToolError } from "../errors"
import { git } from "../git"
import { DESTINATION_PREFIX, PLAIN_DIFF_OPTIONS, SOURCE_PREFIX } from "./secret-diff"

/** How many hunks one listing returns; the rest are counted and `truncated` is set. */
const MAX_LISTED_HUNKS = 200

/** How many lines of a hunk, after its header, a listing previews. */
const PREVIEW_LINES = 8

/** How many hex characters of the diff's SHA-256 the digest keeps. */
const DIGEST_LENGTH = 16

const DIFF_HEADER = "diff --git "
const HUNK_START = "@@"
const BINARY_MARKER = "Binary files"
const BINARY_HEADER = "(binary)"

const HUNK_HEADER_PATTERN = /^@@ -(?<oldStart>\d+)(?:,(?<oldCount>\d+))? \+\d+(?:,(?<newCount>\d+))? @@/

const C_ESCAPES: Record<string, number> = { a: 7, b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, '"': 34, "\\": 92 }

/** One hunk of an unstaged diff. */
export type Hunk = {
  /** The hunk's position in the diff, from 1. */
  id: number
  /** The path of the file, relative to the repository root. */
  file: string
  /** The `@@ … @@` line; `(binary)` for a binary file. */
  header: string
  /** The file's header lines from `diff --git` up to its first hunk, shared by all its hunks. */
  preamble: string
  /** The hunk's lines, its `@@` header first; empty for a binary file. */
  body: string
  added: number
  removed: number
  binary: boolean
}

/** The result of listing the hunks. */
export const hunksSchema = z.object({
  digest: z
    .string()
    .describe("Identifies the diff these hunks come from; pass it to git_commit_stage with the ids you choose."),
  count: z.number().int().describe("The number of hunks in the diff, listed or not."),
  hunks: z
    .array(
      z.object({
        id: z.number().int().describe("The hunk's position in the diff, from 1; unchanged when the list is cut short."),
        file: z.string().describe("The path of the file, relative to the repository root."),
        header: z.string().describe("The hunk's @@ line, or (binary) for a binary file."),
        added: z.number().int().describe("The number of added lines."),
        removed: z.number().int().describe("The number of removed lines."),
        binary: z.boolean().describe("True for a binary file, which cannot be staged by hunk."),
        preview: z.array(z.string()).describe(`The first ${PREVIEW_LINES} lines of the hunk after its header.`),
      }),
    )
    .describe(`The first ${MAX_LISTED_HUNKS} hunks, in diff order.`),
  truncated: z.boolean().describe("True when the diff holds more hunks than were listed."),
})

/** The decoded bytes of a C-quoted path as git writes one (`"a/x\ty"`, octal escapes for other bytes). */
function unquotePath(quoted: string): string {
  const bytes: number[] = []
  const inner = quoted.slice(1, -1)
  for (let i = 0; i < inner.length; i++) {
    const char = inner[i]!
    if (char !== "\\") {
      bytes.push(...Buffer.from(char))
      continue
    }
    const octal = /^[0-7]{1,3}/.exec(inner.slice(i + 1))?.[0]
    if (octal) {
      bytes.push(Number.parseInt(octal, 8))
      i += octal.length
    } else {
      bytes.push(C_ESCAPES[inner[i + 1]!] ?? inner.charCodeAt(i + 1))
      i++
    }
  }
  return Buffer.from(bytes).toString("utf8")
}

/** The end of the quoted string that starts `text`, or -1 when it is not closed. */
function closingQuote(text: string): number {
  for (let i = 1; i < text.length; i++) {
    if (text[i] === "\\") i++
    else if (text[i] === '"') return i
  }
  return -1
}

/**
 * The file a `diff --git` line names. The diff is made without rename
 * detection, so both sides carry the same path: a quoted name is read up to its
 * closing quote, and an unquoted one by length, which keeps spaces in it.
 */
function headerFile(line: string): string {
  const rest = line.slice(DIFF_HEADER.length)
  if (rest.startsWith('"')) {
    const end = closingQuote(rest)
    const path = end < 0 ? rest : unquotePath(rest.slice(0, end + 1))
    return path.startsWith(SOURCE_PREFIX) ? path.slice(SOURCE_PREFIX.length) : path
  }
  const length = (rest.length - SOURCE_PREFIX.length - DESTINATION_PREFIX.length - 1) / 2
  if (Number.isInteger(length)) return rest.slice(SOURCE_PREFIX.length, SOURCE_PREFIX.length + length)
  return rest.slice(SOURCE_PREFIX.length)
}

/**
 * Splits a diff into hunks, numbered from 1 in diff order. A binary file is one
 * hunk with the header `(binary)`; a file with no hunk and no binary marker,
 * such as a mode-only change, is left out.
 */
export function parseHunks(diff: string): Hunk[] {
  const hunks: Hunk[] = []
  const lines = diff.split("\n")
  let id = 0
  let i = 0
  while (i < lines.length) {
    if (!lines[i]!.startsWith(DIFF_HEADER)) {
      i++
      continue
    }
    const file = headerFile(lines[i]!)
    const preambleLines = [lines[i]!]
    i++
    let binary = false
    while (i < lines.length && !lines[i]!.startsWith(HUNK_START) && !lines[i]!.startsWith(DIFF_HEADER)) {
      if (lines[i]!.startsWith(BINARY_MARKER)) binary = true
      preambleLines.push(lines[i]!)
      i++
    }
    const preamble = preambleLines.join("\n")
    if (binary) {
      hunks.push({ id: ++id, file, header: BINARY_HEADER, preamble, body: "", added: 0, removed: 0, binary: true })
      continue
    }
    while (i < lines.length && lines[i]!.startsWith(HUNK_START)) {
      const header = lines[i]!
      const bodyLines = [header]
      i++
      let added = 0
      let removed = 0
      while (i < lines.length && !lines[i]!.startsWith(HUNK_START) && !lines[i]!.startsWith(DIFF_HEADER)) {
        if (lines[i]!.startsWith("+")) added++
        else if (lines[i]!.startsWith("-")) removed++
        bodyLines.push(lines[i]!)
        i++
      }
      // Drop the split artifact of the diff's trailing newline: kept, it
      // becomes an empty "context" line that --recount counts and git apply
      // then rejects ("patch does not apply") on the file's last hunk.
      while (bodyLines.length > 1 && bodyLines[bodyLines.length - 1] === "") bodyLines.pop()
      hunks.push({ id: ++id, file, header, preamble, body: bodyLines.join("\n"), added, removed, binary: false })
    }
  }
  return hunks
}

/**
 * Re-anchors a hunk's new-side start for a patch that leaves earlier hunks of
 * the file out. git apply searches from that start and takes the nearest
 * match, so a start still offset by unselected hunks can land an identical
 * block elsewhere. A zero count means "the line before", as git writes it.
 */
function reanchor(body: string, shift: number): string {
  const groups = HUNK_HEADER_PATTERN.exec(body)?.groups
  if (!groups) return body
  const { oldStart, oldCount, newCount } = groups
  const start = Number(oldStart) + shift + (oldCount === "0" ? 1 : 0) - (newCount === "0" ? 1 : 0)
  const header = `@@ -${oldStart}${oldCount === undefined ? "" : `,${oldCount}`} +${start}${newCount === undefined ? "" : `,${newCount}`} @@`
  return body.replace(HUNK_HEADER_PATTERN, () => header)
}

/**
 * The patch that applies the selected hunks, in diff order, to the index. Each
 * file's header is written once, and its hunks are re-anchored for the
 * hunks of the file that were left out.
 */
export function buildPatch(selected: Hunk[]): string {
  const byFile = new Map<string, { bodies: string[]; shift: number }>()
  for (const hunk of selected) {
    const entry = byFile.get(hunk.preamble) ?? { bodies: [], shift: 0 }
    entry.bodies.push(reanchor(hunk.body, entry.shift))
    entry.shift += hunk.added - hunk.removed
    byFile.set(hunk.preamble, entry)
  }
  const parts: string[] = []
  for (const [preamble, { bodies }] of byFile) parts.push(preamble, ...bodies)
  return parts.join("\n") + "\n"
}

/** Identifies one diff: hunk ids are positions in exactly this diff. */
export function diffDigest(diff: string): string {
  return createHash("sha256").update(diff).digest("hex").slice(0, DIGEST_LENGTH)
}

function checkPaths(root: string, paths: string[]): void {
  for (const path of paths) {
    const inside = relative(root, resolve(root, path))
    if (inside === ".." || inside.startsWith(`..${sep}`) || isAbsolute(inside)) {
      throw new ToolError(
        "invalid_argument",
        `${path} is outside the working tree (${root}); name files or directories inside it.`,
      )
    }
  }
}

/**
 * The unstaged changes of tracked files against the index, as `git diff` writes
 * them; untracked files are not in it. Names are not escaped except where git
 * must quote them, and renames are not detected, so each file has one path.
 */
export async function unstagedDiff(root: string, paths: string[] | undefined, signal?: AbortSignal): Promise<string> {
  checkPaths(root, paths ?? [])
  return git(["-c", "core.quotePath=false", "diff", ...PLAIN_DIFF_OPTIONS, "--no-renames", "--", ...(paths ?? [])], {
    cwd: root,
    signal,
  })
}

/** Lists the unstaged hunks of tracked files with the digest of the diff they come from. */
export async function readHunks(
  root: string,
  paths: string[] | undefined,
  signal?: AbortSignal,
): Promise<z.output<typeof hunksSchema>> {
  const diff = await unstagedDiff(root, paths, signal)
  const hunks = parseHunks(diff)
  return {
    digest: diffDigest(diff),
    count: hunks.length,
    hunks: hunks.slice(0, MAX_LISTED_HUNKS).map(({ id, file, header, added, removed, binary, body }) => ({
      id,
      file,
      header,
      added,
      removed,
      binary,
      preview: body.split("\n").slice(1, 1 + PREVIEW_LINES),
    })),
    truncated: hunks.length > MAX_LISTED_HUNKS,
  }
}
