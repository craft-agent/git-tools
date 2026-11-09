import { stat } from "node:fs/promises"
import { z } from "zod"
import { ToolError } from "../errors"
import { classifyGitFailure, git, gitResult } from "../git"
import type { RewriteCheck } from "../rewrite"
import { gitPath } from "../tree"
import { landedFileSchema, landedFiles, remainingChanges, remainingSchema, splitNames } from "./commit-landed"
import { checkMessage, lintSchema } from "./lint"
import { DEFAULT_BODY_WRAP, DEFAULT_SUBJECT_MAX, MAX_WIDTH, MIN_WIDTH } from "./message-rules"
import { SCAN_DIFF_OPTIONS, type Finding, findingSchema, scanDiff } from "./secret-diff"
import { scanSecrets } from "./secrets"

/** A commit runs the repository's hooks, which can be slow. */
const COMMIT_TIMEOUT_MS = 600_000
const HOOK_OUTPUT_LINES = 40
const COMMIT_HOOKS = ["pre-commit", "prepare-commit-msg", "commit-msg"] as const
const EXECUTABLE_BITS = 0o111

/** The arguments every tool that makes a commit takes besides its message. */
export const commitCheckInput = {
  accept_findings: z
    .array(z.string())
    .optional()
    .describe(
      "The fingerprints (file:line:rule) of secret findings you read and judged false positives; they no longer stop the commit.",
    ),
  subject_max: z
    .number()
    .int()
    .min(MIN_WIDTH)
    .max(MAX_WIDTH)
    .optional()
    .describe(`The subject's hard limit in columns (default ${DEFAULT_SUBJECT_MAX}).`),
  body_wrap: z
    .number()
    .int()
    .min(MIN_WIDTH)
    .max(MAX_WIDTH)
    .optional()
    .describe(`The body width in columns that draws a warning (default ${DEFAULT_BODY_WRAP}).`),
}

/** The result every tool that makes a commit returns. */
export const commitOutput = z.object({
  root: z.string().describe("The absolute path of the working tree root."),
  sha: z.string().describe("The new commit."),
  subject: z.string().describe("The subject line of the commit as it landed."),
  message_matches: z
    .boolean()
    .describe("Whether the message that landed equals the one that was checked; false when a hook rewrote it."),
  files: z.array(landedFileSchema).describe("The files the commit changed, with their line counts."),
  changed_by_hook: z
    .array(z.string())
    .describe("The files whose committed content differs from what was staged and checked: a hook changed them."),
  hook_findings: z
    .array(findingSchema)
    .describe("Credentials in the changes a hook made; they were not part of the scan before the commit."),
  left_modified: z
    .array(z.string())
    .describe("The files a hook modified without staging them; the commit does not hold those changes."),
  remaining: remainingSchema.describe("What is still uncommitted after the commit."),
  accepted: z.array(z.string()).describe("The fingerprints of the findings that were let through."),
  warnings: lintSchema.shape.warnings,
})

/** What `runCommit` commits and how it checks it. */
export type CommitRun = {
  /** The full message, before it is normalized. */
  message: string
  /** Replace HEAD instead of adding a commit. */
  amend: boolean
  acceptFindings: string[] | undefined
  limits: { subjectMax: number; bodyWrap: number }
  /** `"commitlint"` leaves the built-in message rules out, for a message git generated. */
  lintRules: "all" | "commitlint"
}

/** The limits a caller's `subject_max` and `body_wrap` give, with the defaults. */
export function messageLimits(args: { subject_max?: number; body_wrap?: number }): CommitRun["limits"] {
  return { subjectMax: args.subject_max ?? DEFAULT_SUBJECT_MAX, bodyWrap: args.body_wrap ?? DEFAULT_BODY_WRAP }
}

/** Throws `rewrite_refused` with the rule's reasons when the check does not allow the rewrite. */
export function requireRewriteAllowed(check: RewriteCheck): void {
  if (check.allowed) return
  throw new ToolError(
    "rewrite_refused",
    `${check.refusals.map((refusal) => refusal.message).join(" ")} Make a new commit instead.`,
    { details: { refusals: check.refusals, warnings: check.warnings } },
  )
}

/** The message the way git would clean it (trailing blanks, runs of blank lines), so what is checked is what lands. */
export async function normalizeMessage(
  root: string,
  message: string,
  signal: AbortSignal | undefined,
): Promise<string> {
  const normalized = await git(["stripspace"], {
    cwd: root,
    signal,
    stdin: message.replace(/\r\n/g, "\n"),
  })
  if (normalized.trim() === "") throw new ToolError("invalid_argument", "The message is empty.")
  return normalized
}

function sortFindings(findings: Finding[], acceptFingerprints: string[] | undefined) {
  const allowed = new Set(acceptFingerprints)
  const accepted = [...new Set(findings.filter((f) => allowed.has(f.fingerprint)).map((f) => f.fingerprint))]
  return { rejected: findings.filter((f) => !allowed.has(f.fingerprint)), accepted }
}

async function modifiedFiles(root: string, signal: AbortSignal | undefined): Promise<string[]> {
  return splitNames(await git(["diff", "--name-only", "-z"], { cwd: root, signal }))
}

async function isExecutableFile(path: string): Promise<boolean> {
  try {
    const stats = await stat(path)
    return stats.isFile() && (stats.mode & EXECUTABLE_BITS) !== 0
  } catch {
    return false
  }
}

/** The commit hooks that would run here. */
async function activeHooks(root: string, signal: AbortSignal | undefined): Promise<string[]> {
  const active: string[] = []
  for (const name of COMMIT_HOOKS) {
    if (await isExecutableFile(await gitPath(root, `hooks/${name}`, signal))) active.push(name)
  }
  return active
}

function lastLines(text: string): string {
  return text.trim().split("\n").slice(-HOOK_OUTPUT_LINES).join("\n")
}

/** Reads what the new commit holds and what is left; the commit exists, so these reads carry no signal. */
async function describeLanded(root: string, stagedTree: string, message: string) {
  const options = { cwd: root }
  const sha = (await git(["rev-parse", "HEAD"], options)).trim()
  const landed = await git(["log", "-1", "--format=%B", "HEAD"], options)
  const changedByHook = splitNames(await git(["diff", "--name-only", "-z", stagedTree, "HEAD^{tree}"], options))
  const hookFindings = changedByHook.length
    ? scanDiff(await git(["diff", ...SCAN_DIFF_OPTIONS, stagedTree, "HEAD^{tree}", "--"], options))
    : []
  return {
    sha,
    subject: landed.split("\n")[0]!,
    message_matches: landed.trimEnd() === message.trimEnd(),
    files: await landedFiles(root),
    changed_by_hook: changedByHook,
    hook_findings: hookFindings,
    remaining: await remainingChanges(root),
  }
}

/**
 * Commits what is staged: normalizes and lints the message, scans the staged
 * diff for credentials, commits the message byte for byte through the
 * repository's hooks, and reports what landed.
 */
export async function runCommit(
  root: string,
  run: CommitRun,
  signal: AbortSignal | undefined,
): Promise<z.output<typeof commitOutput>> {
  const options = { cwd: root, signal }
  const message = await normalizeMessage(root, run.message, signal)

  const lint = await checkMessage(root, message, run.limits, signal, run.lintRules)
  if (lint.errors.length > 0) {
    throw new ToolError("check_failed", "The message failed its checks; fix the errors in details and commit again.", {
      details: { check: "lint", ...lint },
    })
  }

  // The index as it was checked, to tell what a hook staged later.
  const stagedTree = (await git(["write-tree"], options)).trim()
  const scan = await scanSecrets(root, { target: "staged" }, signal)
  const { rejected, accepted } = sortFindings(scan.findings, run.acceptFindings)
  if (rejected.length > 0) {
    throw new ToolError(
      "check_failed",
      "The staged changes hold what looks like credentials; remove them, or pass the fingerprints of the false positives in accept_findings after reading each, and commit again.",
      { details: { check: "secrets", gitleaks: scan.gitleaks, findings: rejected, accepted } },
    )
  }

  const unstagedBefore = new Set(await modifiedFiles(root, signal))
  const commitArgs = ["commit", "--cleanup=verbatim", ...(run.amend ? ["--amend"] : []), "-F", "-"]
  const result = await gitResult(commitArgs, { ...options, stdin: message, timeoutMs: COMMIT_TIMEOUT_MS })
  // The commit may exist now, so nothing from here on is cancelled: the result must reach the caller.
  const leftModified = (await modifiedFiles(root, undefined)).filter((file) => !unstagedBefore.has(file))

  if (result.code !== 0) {
    const hooks = await activeHooks(root, undefined)
    // Not every failure is a hook's: identity, signing and unmerged paths fail here too.
    if (hooks.length === 0) throw classifyGitFailure(commitArgs, result)
    throw new ToolError(
      "check_failed",
      "A commit hook stopped the commit; fix what its output in details reports and commit again.",
      {
        details: {
          check: "hook",
          hooks,
          exit_code: result.code,
          output: lastLines(`${result.stdout}\n${result.stderr}`),
          left_modified: leftModified,
        },
      },
    )
  }

  return {
    root,
    ...(await describeLanded(root, stagedTree, message)),
    left_modified: leftModified,
    accepted,
    warnings: lint.warnings,
  }
}
