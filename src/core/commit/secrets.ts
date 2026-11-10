import { z } from "zod"
import { ToolError, isAbortError } from "../errors"
import { exec } from "../exec"
import { DEFAULT_GIT_TIMEOUT_MS, git, gitEnv } from "../git"
import { SCAN_DIFF_OPTIONS, dedupe, type Finding, findingSchema, makeFinding, scanDiff } from "./secret-diff"

/** How many characters of a secret gitleaks reports are kept. */
const GITLEAKS_SECRET_LENGTH = 16

/** The targets `scanSecrets` can look at. */
export const SCAN_TARGETS = ["staged", "worktree", "range"] as const

/** What to scan: the staged changes, the unstaged changes of the working tree, or a commit range. */
export type ScanTarget = (typeof SCAN_TARGETS)[number]

/** Whether gitleaks ran: `not_installed` when it is not on the `PATH`, `failed` when it exited non-zero or printed no report. */
export type GitleaksStatus = "ran" | "not_installed" | "failed"

/** What `scanSecrets` looks at; `range` goes with the `range` target only. */
export type ScanScope = { target: ScanTarget; range?: string; paths?: string[] }

const gitleaksReportSchema = z.array(
  z.object({
    File: z.string(),
    StartLine: z.number().int(),
    RuleID: z.string(),
    Secret: z.string().optional(),
  }),
)

/** The result of `secrets`. */
export const secretsSchema = z.object({
  pass: z.boolean().describe("True when nothing was found."),
  target: z.enum(SCAN_TARGETS).describe("What was scanned."),
  gitleaks: z
    .enum(["ran", "not_installed", "failed"])
    .describe(
      "Whether gitleaks ran beside the built-in rules, is not installed, or failed; the built-in rules ran in every case.",
    ),
  count: z.number().int().describe("The number of findings."),
  findings: z.array(findingSchema).describe("What looks like a credential, with its value redacted."),
})

function validateScope(scope: ScanScope): void {
  const range = scope.range?.trim()
  if (scope.target === "range") {
    if (!range) {
      throw new ToolError("invalid_argument", 'The "range" target needs `range`, for example "main..HEAD".')
    }
    if (range.startsWith("-")) {
      throw new ToolError("invalid_argument", `\`range\` must be a revision range, not an option: ${range}`)
    }
  } else if (scope.range !== undefined) {
    throw new ToolError("invalid_argument", `\`range\` goes with the "range" target only, not "${scope.target}".`)
  }
}

function diffArguments(scope: ScanScope): string[] {
  const args = ["diff", ...SCAN_DIFF_OPTIONS]
  if (scope.target === "staged") args.push("--cached")
  if (scope.target === "range") args.push(scope.range!.trim())
  args.push("--", ...(scope.paths ?? []))
  return args
}

function gitleaksArguments(root: string, scope: ScanScope): string[] {
  const mode = {
    staged: ["--staged"],
    worktree: ["--pre-commit"],
    range: [`--log-opts=${scope.range?.trim()}`],
  }[scope.target]
  return [
    "gitleaks",
    "git",
    "--no-banner",
    "--redact",
    "--report-format",
    "json",
    "--report-path",
    "-",
    "--exit-code",
    "0",
    ...mode,
    root,
  ]
}

function isSpawnNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function normalizeScopePath(path: string): string {
  return path.replace(/^(?:\.\/)+/, "").replace(/\/+$/, "")
}

function isUnderPaths(file: string, paths: string[]): boolean {
  return paths
    .map(normalizeScopePath)
    .some((path) => path === "" || path === "." || file === path || file.startsWith(`${path}/`))
}

async function runGitleaks(
  root: string,
  scope: ScanScope,
  signal: AbortSignal | undefined,
): Promise<{ gitleaks: GitleaksStatus; findings: Finding[] }> {
  let result
  try {
    result = await exec(gitleaksArguments(root, scope), {
      cwd: root,
      env: gitEnv(),
      timeoutMs: DEFAULT_GIT_TIMEOUT_MS,
      signal,
    })
  } catch (error) {
    if (isSpawnNotFound(error)) return { gitleaks: "not_installed", findings: [] }
    if (isAbortError(error)) throw error
    return { gitleaks: "failed", findings: [] }
  }
  if (result.code !== 0) return { gitleaks: "failed", findings: [] }
  let report
  try {
    report = gitleaksReportSchema.safeParse(JSON.parse(result.stdout))
  } catch {
    return { gitleaks: "failed", findings: [] }
  }
  if (!report.success) return { gitleaks: "failed", findings: [] }
  const paths = scope.paths?.length ? scope.paths : undefined
  const findings = report.data
    .filter((item) => !paths || isUnderPaths(item.File, paths))
    .map((item) =>
      makeFinding(
        item.File,
        item.StartLine,
        item.RuleID,
        (item.Secret ?? "").slice(0, GITLEAKS_SECRET_LENGTH),
        "gitleaks",
      ),
    )
  return { gitleaks: "ran", findings }
}

/**
 * Scans the staged changes, the unstaged changes of the working tree or a
 * commit range for secrets: the builtin rules over the diff, plus gitleaks
 * when it is installed. A gitleaks that is missing or fails never fails the
 * scan; `gitleaks` says what happened and the builtin findings are returned
 * either way.
 */
export async function scanSecrets(
  root: string,
  scope: ScanScope,
  signal?: AbortSignal,
): Promise<{ gitleaks: GitleaksStatus; findings: Finding[] }> {
  validateScope(scope)
  const diff = await git(diffArguments(scope), { cwd: root, signal })
  const builtin = scanDiff(diff)
  const { gitleaks, findings } = await runGitleaks(root, scope, signal)
  return { gitleaks, findings: dedupe([...builtin, ...findings]) }
}

/**
 * Scans the commits a `git log` revision expression selects (`revisions`, one
 * argument per item, built by the caller from commit ids and refs) by each
 * commit's own patch, with the builtin rules, plus gitleaks over the same
 * commits when it is installed. A secret one commit adds and a later one
 * removes is found, which the net diff of the range would miss. As in
 * `scanSecrets`, a missing or failing gitleaks never fails the scan.
 */
export async function scanCommits(
  root: string,
  revisions: string[],
  signal?: AbortSignal,
): Promise<{ gitleaks: GitleaksStatus; findings: Finding[] }> {
  const patches = await git(["log", "--format=", "-p", ...SCAN_DIFF_OPTIONS, ...revisions], { cwd: root, signal })
  const builtin = scanDiff(patches)
  const { gitleaks, findings } = await runGitleaks(root, { target: "range", range: revisions.join(" ") }, signal)
  return { gitleaks, findings: dedupe([...builtin, ...findings]) }
}
