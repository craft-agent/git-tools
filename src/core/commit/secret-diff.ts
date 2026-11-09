import { z } from "zod"
import { scanLine } from "./secret-rules"

const HUNK_HEADER_PATTERN = /^@@ -\d+(?:,(?<oldCount>\d+))? \+(?<newStart>\d+)(?:,(?<newCount>\d+))? @@/
const NULL_DEVICE = "/dev/null"

/** The prefix `git diff` puts on the new side's paths; the diff is asked for with it and parsed by it. */
export const DESTINATION_PREFIX = "b/"

/** The prefix `git diff` puts on the old side's paths; the diff is asked for with it and parsed by it. */
export const SOURCE_PREFIX = "a/"

/** The `git diff` options that make its output plain text with the two prefixes the parsers expect. */
export const PLAIN_DIFF_OPTIONS = [
  "--no-color",
  "--no-ext-diff",
  `--src-prefix=${SOURCE_PREFIX}`,
  `--dst-prefix=${DESTINATION_PREFIX}`,
]

/** The `git diff` options for the output `scanDiff` reads: plain text with no context lines. */
export const SCAN_DIFF_OPTIONS = [...PLAIN_DIFF_OPTIONS, "--unified=0"]

/** One secret found on an added line. */
export const findingSchema = z.object({
  file: z.string().describe("The path of the file, relative to the repository root."),
  line: z.number().int().describe("The line number on the new side of the diff."),
  rule: z.string().describe("The id of the rule that matched, such as github-pat or generic-secret."),
  redacted: z.string().describe("The matched value with its middle hidden; the raw value is never returned."),
  source: z.enum(["builtin", "gitleaks"]).describe("Which scanner found it."),
  fingerprint: z.string().describe("A stable id for the finding: file:line:rule."),
})

export type Finding = z.output<typeof findingSchema>

/** A finding whose fingerprint is `file:line:rule`. */
export function makeFinding(
  file: string,
  line: number,
  rule: string,
  redacted: string,
  source: Finding["source"],
): Finding {
  return { file, line, rule, redacted, source, fingerprint: `${file}:${line}:${rule}` }
}

/** The findings without repeats of the same file, line, rule and value, in their order. */
export function dedupe(findings: Finding[]): Finding[] {
  const seen = new Set<string>()
  return findings.filter((finding) => {
    const key = `${finding.fingerprint}:${finding.redacted}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function destinationPath(header: string): string {
  let path = header.replace(/\t.*$/, "")
  if (path.length > 1 && path.startsWith('"') && path.endsWith('"')) path = path.slice(1, -1)
  if (path === NULL_DEVICE) return ""
  return path.startsWith(DESTINATION_PREFIX) ? path.slice(DESTINATION_PREFIX.length) : path
}

/**
 * Scans the added lines of `git diff --unified=0` output with the builtin
 * rules. Removed lines are never scanned. Findings come in diff order, one per
 * file, line, rule and value.
 */
export function scanDiff(diff: string): Finding[] {
  const findings: Finding[] = []
  let file = ""
  let newLine = 0
  let oldLeft = 0
  let newLeft = 0
  for (const raw of diff.split("\n")) {
    if (oldLeft > 0 || newLeft > 0) {
      const kind = raw[0]
      if (kind === "+") {
        for (const { rule, redacted } of scanLine(file, raw.slice(1))) {
          findings.push(makeFinding(file, newLine, rule, redacted, "builtin"))
        }
        newLine++
        newLeft--
        continue
      }
      if (kind === "-") {
        oldLeft--
        continue
      }
      if (kind === " ") {
        newLine++
        oldLeft--
        newLeft--
        continue
      }
      if (kind === "\\") continue
      oldLeft = 0
      newLeft = 0
    }
    if (raw.startsWith("diff ")) {
      file = ""
    } else if (raw.startsWith("+++ ")) {
      file = destinationPath(raw.slice(4))
    } else {
      const groups = HUNK_HEADER_PATTERN.exec(raw)?.groups
      if (groups) {
        oldLeft = Number(groups.oldCount ?? 1)
        newLeft = Number(groups.newCount ?? 1)
        newLine = Number(groups.newStart)
      }
    }
  }
  return dedupe(findings)
}
