import { readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { exec } from "../exec"
import { DEFAULT_GIT_TIMEOUT_MS, git, gitEnv, gitResult } from "../git"
import { COMMITLINT_CONFIG_FILES } from "../repo/conventions"
import { gitPath } from "../tree"
import {
  CONVENTIONAL_PATTERN,
  displayWidth,
  isExemptFromShape,
  lintMessage,
  SUBJECT_TARGET_MAX,
  SUBJECT_TARGET_MIN,
  type Violation,
} from "./message-rules"

const HISTORY_SAMPLE = 100
const MIN_TARGET_SUBJECTS = 20
const TARGET_PERCENTILE = 0.9
const MIN_CONVENTIONAL_SUBJECTS = 10
const COMMITLINT_OUTPUT_LINES = 40
const COMMITLINT_BIN = "node_modules/.bin/commitlint"
const HUSKY_HOOK = ".husky/commit-msg"
const SQUASH_MERGE_SUFFIX = / \(#\d+\)$/
const BOT_AUTHOR_PATTERN = /\[bot\]/i

/** What the repository's history says about its subjects. */
export type HistoryProfile = {
  subject_target: { target: number; source: "history" | "default"; sample: number }
  conventional: boolean
}

const DEFAULT_PROFILE: HistoryProfile = {
  subject_target: { target: SUBJECT_TARGET_MIN, source: "default", sample: 0 },
  conventional: false,
}

/**
 * The subject width the repository's recent history aims for (the 90th
 * percentile of its subjects' widths, clamped to 50..60) and whether it uses
 * the `type(scope): summary` shape. Squash-merge titles, merges, reverts,
 * autosquash commits and bots' commits are left out; an unborn HEAD or a short
 * history gives the defaults.
 */
export async function historyProfile(root: string, signal?: AbortSignal): Promise<HistoryProfile> {
  const options = { cwd: root, signal }
  const head = await gitResult(["rev-parse", "--verify", "--quiet", "HEAD"], options)
  if (head.code !== 0) return DEFAULT_PROFILE
  const log = await git(["log", "--no-merges", `-${HISTORY_SAMPLE}`, "--format=%an%x00%s%x01"], options)
  const subjects: string[] = []
  for (const record of log.split("\x01")) {
    const [author = "", subject = ""] = record.replace(/^\n/, "").split("\0")
    if (!subject) continue
    if (SQUASH_MERGE_SUFFIX.test(subject) || isExemptFromShape(subject) || BOT_AUTHOR_PATTERN.test(author)) continue
    subjects.push(subject)
  }
  const conventionalCount = subjects.filter((subject) => CONVENTIONAL_PATTERN.test(subject)).length
  const conventional = subjects.length >= MIN_CONVENTIONAL_SUBJECTS && conventionalCount * 2 >= subjects.length
  if (subjects.length < MIN_TARGET_SUBJECTS) {
    return { subject_target: { ...DEFAULT_PROFILE.subject_target, sample: subjects.length }, conventional }
  }
  const widths = subjects.map(displayWidth).sort((a, b) => a - b)
  const percentile = widths[Math.ceil(widths.length * TARGET_PERCENTILE) - 1]!
  return {
    subject_target: {
      target: Math.min(SUBJECT_TARGET_MAX, Math.max(SUBJECT_TARGET_MIN, percentile)),
      source: "history",
      sample: subjects.length,
    },
    conventional,
  }
}

/** Whether the repository's commitlint ran, is missing, or is not in use. */
export type CommitlintStatus = "ran" | "not_installed" | "not_configured"

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

/** The first line of the repository's commit-msg hook that runs commitlint, if any. */
async function commitlintHook(root: string, signal?: AbortSignal): Promise<string | null> {
  // husky points core.hooksPath at a generated directory that may be missing in a fresh
  // worktree; the hook it runs is .husky/commit-msg.
  const candidates = [await gitPath(root, "hooks/commit-msg", signal), join(root, HUSKY_HOOK)]
  for (const path of candidates) {
    let text: string
    try {
      text = await readFile(path, "utf8")
    } catch {
      continue
    }
    const line = text.split("\n").find((candidate) => candidate.includes("commitlint") && !/^\s*#/.test(candidate))
    if (line) return line.trim()
  }
  return null
}

async function commitlintConfigured(root: string): Promise<boolean> {
  for (const name of COMMITLINT_CONFIG_FILES) {
    if (await isFile(join(root, name))) return true
  }
  try {
    const manifest: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"))
    return typeof manifest === "object" && manifest !== null && "commitlint" in manifest
  } catch {
    return false
  }
}

/**
 * Runs the repository's own commitlint on `message`. When it is not
 * installed, a commit-msg hook that runs it makes that an error (the commit
 * would fail there), a configuration alone a warning.
 */
export async function commitlint(
  root: string,
  message: string,
  signal?: AbortSignal,
): Promise<{ status: CommitlintStatus; hook: string | null; violations: Violation[] }> {
  const hook = await commitlintHook(root, signal)
  const binary = join(root, COMMITLINT_BIN)
  if (await isFile(binary)) {
    const result = await exec([binary], {
      cwd: root,
      env: gitEnv(),
      stdin: message,
      signal,
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
    })
    if (result.code === 0) return { status: "ran", hook, violations: [] }
    const output = `${result.stdout}\n${result.stderr}`.trim().split("\n").slice(-COMMITLINT_OUTPUT_LINES).join("\n")
    return {
      status: "ran",
      hook,
      violations: [{ rule: "commitlint", severity: "error", message: output || "commitlint reported problems." }],
    }
  }
  if (hook) {
    return {
      status: "not_installed",
      hook,
      violations: [
        {
          rule: "commitlint-not-installed",
          severity: "error",
          message: `The commit-msg hook runs commitlint (\`${hook}\`), but it is not installed here; install the dependencies first, or the hook rejects the commit.`,
        },
      ],
    }
  }
  if (await commitlintConfigured(root)) {
    return {
      status: "not_installed",
      hook,
      violations: [
        {
          rule: "commitlint-not-installed",
          severity: "warning",
          message: "A commitlint configuration exists but commitlint is not installed, so only the built-in rules ran.",
        },
      ],
    }
  }
  return { status: "not_configured", hook, violations: [] }
}

const findingSchema = z.object({
  rule: z.string().describe("The rule that found the problem."),
  message: z.string().describe("What is wrong."),
})

/** The result of `lint`. */
export const lintSchema = z.object({
  pass: z.boolean().describe("True when no error was found; warnings do not fail it."),
  commitlint: z
    .enum(["ran", "not_installed", "not_configured"])
    .describe("Whether the repository's commitlint ran, is configured but missing, or is not in use."),
  hook: z.string().nullable().describe("The line of the commit-msg hook that runs commitlint, or null."),
  subject_target: z
    .object({
      target: z.number().int().describe("The subject width in columns above which a warning is drawn."),
      source: z.enum(["history", "default"]).describe("Whether the target comes from the repository's history."),
      sample: z.number().int().describe("How many history subjects the target was inferred from."),
    })
    .describe("The subject width the repository's history aims for."),
  conventional: z
    .boolean()
    .describe("Whether the type(scope) shape of the subject was checked, because the history uses it."),
  errors: z.array(findingSchema).describe("Problems that stop the commit."),
  warnings: z.array(findingSchema).describe("Advice that does not stop the commit."),
})

/**
 * Checks a commit message with the built-in rules, the history's profile and
 * the repository's commitlint, and sorts the findings into errors and warnings.
 * With `rules` set to `"commitlint"` the built-in rules are left out, for a
 * message git generated rather than an author wrote.
 */
export async function checkMessage(
  root: string,
  message: string,
  limits: { subjectMax: number; bodyWrap: number },
  signal?: AbortSignal,
  rules: "all" | "commitlint" = "all",
): Promise<z.output<typeof lintSchema>> {
  const profile = await historyProfile(root, signal)
  const violations =
    rules === "all"
      ? lintMessage(message, {
          ...limits,
          subjectTarget: profile.subject_target.target,
          conventional: profile.conventional,
        })
      : []
  const checked = await commitlint(root, message, signal)
  violations.push(...checked.violations)
  const findings = (severity: Violation["severity"]) =>
    violations.filter((violation) => violation.severity === severity).map(({ rule, message }) => ({ rule, message }))
  const errors = findings("error")
  return {
    pass: errors.length === 0,
    commitlint: checked.status,
    hook: checked.hook,
    subject_target: profile.subject_target,
    conventional: profile.conventional,
    errors,
    warnings: findings("warning"),
  }
}
