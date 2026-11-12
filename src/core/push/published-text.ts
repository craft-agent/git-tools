import { readFile, stat } from "node:fs/promises"
import { isAbsolute } from "node:path"
import { z } from "zod"
import { cut } from "../describe"
import { ToolError, isAbortError } from "../errors"
import type { ToolOptions } from "../tool"

/**
 * The rules for what a push publishes: words that a branch name or a commit
 * subject must not carry. The package ships none; the words come from the
 * consumer, as a JSON file the `published_text_rules` option names by its
 * absolute path, and a tool reads the file on every call.
 */

/** The name of the tool option that holds the path of the rules file. */
export const PUBLISHED_TEXT_RULES_OPTION = "published_text_rules"

const MAX_FILE_BYTES = 64 * 1024
const MAX_RULES = 100
const MAX_PATTERN_LENGTH = 500
const MAX_HINT_LENGTH = 300
const MAX_MATCH_LENGTH = 60
/** The length of a commit id in a finding: enough to tell commits apart, and short to read. */
const SHORT_SHA_LENGTH = 12
const RULE_NAME_PATTERN = /^[a-z][a-z0-9-]{0,39}$/
/** `g` and `y` are left out: they make a pattern remember where it stopped, so a second text would be matched from the middle. */
const FLAGS_PATTERN = /^[imsu]{0,4}$/

const ruleEntrySchema = z.strictObject({
  rule: z
    .string()
    .regex(RULE_NAME_PATTERN, "must be 1 to 40 lowercase letters, digits and hyphens, starting with a letter"),
  pattern: z.string().min(1).max(MAX_PATTERN_LENGTH),
  flags: z.string().regex(FLAGS_PATTERN, "must be drawn from i, m, s and u").optional(),
  hint: z.string().min(1).max(MAX_HINT_LENGTH),
})

/** A rule of the file: the pattern a published text must not match, and what to do instead. */
export type PublishedTextRule = { rule: string; pattern: RegExp; hint: string }

function invalidRules(path: string, problem: string): ToolError {
  return new ToolError("invalid_argument", `The ${PUBLISHED_TEXT_RULES_OPTION} setting (${path}): ${problem}.`)
}

function describeEntryIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) =>
      issue.code === "unrecognized_keys"
        ? `unknown key ${issue.keys.map((key) => `"${key}"`).join(", ")}`
        : `${issue.path.join(".") || "entry"} ${issue.message}`,
    )
    .join("; ")
}

async function readRulesFile(path: string, signal: AbortSignal | undefined): Promise<string> {
  const tooLarge = `the file is larger than ${MAX_FILE_BYTES / 1024} KiB`
  try {
    const info = await stat(path)
    if (!info.isFile()) throw invalidRules(path, "it is not a file")
    if (info.size > MAX_FILE_BYTES) throw invalidRules(path, tooLarge)
    const content = await readFile(path, { signal })
    if (content.length > MAX_FILE_BYTES) throw invalidRules(path, tooLarge)
    return content.toString("utf8")
  } catch (error) {
    if (error instanceof ToolError || isAbortError(error)) throw error
    const reason = (error as NodeJS.ErrnoException).code === "ENOENT" ? "the file does not exist" : String(error)
    throw invalidRules(path, `the file could not be read (${reason})`)
  }
}

function parseRulesJson(path: string, text: string): unknown[] {
  let document: unknown
  try {
    document = JSON.parse(text)
  } catch (error) {
    throw invalidRules(path, `the file is not valid JSON (${error instanceof Error ? error.message : String(error)})`)
  }
  if (!Array.isArray(document)) throw invalidRules(path, "the file must hold a JSON array of rules")
  if (document.length > MAX_RULES) throw invalidRules(path, `the file holds more than ${MAX_RULES} rules`)
  return document
}

function compileRules(path: string, entries: unknown[]): PublishedTextRule[] {
  const indexOfRule = new Map<string, number>()
  return entries.map((entry, index) => {
    const parsed = ruleEntrySchema.safeParse(entry)
    if (!parsed.success) throw invalidRules(path, `entry ${index}: ${describeEntryIssues(parsed.error)}`)
    const { rule, pattern, flags, hint } = parsed.data
    const first = indexOfRule.get(rule)
    if (first !== undefined)
      throw invalidRules(path, `entry ${index}: the rule "${rule}" is already used by entry ${first}`)
    indexOfRule.set(rule, index)
    try {
      return { rule, pattern: new RegExp(pattern, flags), hint }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error)
      throw invalidRules(path, `entry ${index}: the pattern of "${rule}" does not compile (${reason})`)
    }
  })
}

/**
 * The rules of the file the `published_text_rules` option names; none when it
 * is not set. The value is an absolute path to a JSON array
 * (at most 100 entries, in a file of at most 64 KiB) of
 * `{ rule, pattern, flags?, hint }`:
 * `rule` is a unique lowercase name, `pattern` a regular expression of up to
 * 500 characters, `flags` any of `imsu`, and `hint` up to 300 characters
 * saying what to write instead. Every mistake is `invalid_argument` naming the
 * setting, the path and what is wrong. Nothing is cached, so an edited file
 * applies on the next call.
 */
export async function loadPublishedTextRules(
  options: ToolOptions | undefined,
  signal?: AbortSignal,
): Promise<PublishedTextRule[]> {
  const option = options?.[PUBLISHED_TEXT_RULES_OPTION]
  const path = typeof option === "string" ? option.trim() : undefined
  if (!path) return []
  if (!isAbsolute(path)) throw invalidRules(path, "the value must be an absolute path")
  return compileRules(path, parseRulesJson(path, await readRulesFile(path, signal)))
}

/** A text a push publishes: a branch name, or a commit subject with the commit's full sha and the branch it is pushed with. */
export type PublishedText = { field: "branch" | "subject"; branch: string; sha?: string; text: string }

/** One rule that matched one published text. */
export const publishedTextFindingSchema = z.object({
  rule: z.string().describe("The name of the rule that matched."),
  field: z.enum(["branch", "subject"]).describe("What matched: a branch name or a commit subject."),
  branch: z.string().describe("The branch that is pushed, or the one the commit is pushed with."),
  sha: z
    .string()
    .nullable()
    .describe("The first 12 hexadecimal digits of the commit for a subject; null for a branch name."),
  match: z.string().describe("The first match, cut to 60 characters."),
  hint: z.string().describe("What to write instead, from the rule."),
  fingerprint: z
    .string()
    .describe("A stable id for the finding: rule:branch:name for a branch, rule:commit:sha for a subject."),
})

export type PublishedTextFinding = z.output<typeof publishedTextFindingSchema>

function findingOf(rule: PublishedTextRule, published: PublishedText, match: string): PublishedTextFinding {
  const base = {
    rule: rule.rule,
    field: published.field,
    branch: published.branch,
    match: cut(match, MAX_MATCH_LENGTH),
    hint: rule.hint,
  }
  if (published.field === "branch") {
    return { ...base, sha: null, fingerprint: `${rule.rule}:branch:${published.branch}` }
  }
  if (published.sha === undefined) throw new Error("A commit subject needs the sha of its commit.")
  const sha = published.sha.slice(0, SHORT_SHA_LENGTH)
  return { ...base, sha, fingerprint: `${rule.rule}:commit:${sha}` }
}

/**
 * The rules that match the published texts: at most one finding per rule and
 * text, in text order and then rule order. A commit pushed with several
 * branches is reported once, under the first of them.
 */
export function publishedTextFindings(rules: PublishedTextRule[], texts: PublishedText[]): PublishedTextFinding[] {
  const seen = new Set<string>()
  const findings: PublishedTextFinding[] = []
  for (const published of texts) {
    for (const rule of rules) {
      const match = published.text.match(rule.pattern)?.[0]
      if (match === undefined) continue
      const finding = findingOf(rule, published, match)
      if (seen.has(finding.fingerprint)) continue
      seen.add(finding.fingerprint)
      findings.push(finding)
    }
  }
  return findings
}
