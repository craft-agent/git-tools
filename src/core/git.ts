import type { Stats } from "node:fs"
import { stat } from "node:fs/promises"
import { ToolError } from "./errors"
import { abortError, exec, type ExecResult } from "./exec"

/**
 * The oldest git with every option the tools use (`rev-parse --path-format`, 2.31);
 * a domain that needs a newer option raises it.
 */
export const MIN_GIT_VERSION = "2.31.0"

/** How long one git call may run before it is stopped. */
export const DEFAULT_GIT_TIMEOUT_MS = 120_000

const VERSION_CHECK_TIMEOUT_MS = 15_000
const MAX_MESSAGE_LENGTH = 2000

const GIT_MISSING_MESSAGE = "git is not installed or not on PATH; install it from https://git-scm.com."

/**
 * The environment variables passed through from `process.env` when set: what git
 * needs to find itself, its config, the locale (not forced, so messages and
 * hook output reach the person in their language), the SSH agent, signing,
 * proxies and `gh`'s authentication for `gh auth git-credential`; nothing
 * else, so `GIT_DIR`, `GIT_WORK_TREE`, `GIT_INDEX_FILE`, `GIT_CONFIG_*` or a
 * secret in the caller's environment never reaches git or a hook.
 */
export const GIT_PASSED_ENV = [
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "TZ",
  "TMPDIR",
  "XDG_CONFIG_HOME",
  "XDG_RUNTIME_DIR",
  "DBUS_SESSION_BUS_ADDRESS",
  "SSH_AUTH_SOCK",
  "GIT_SSH_COMMAND",
  "GNUPGHOME",
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "NO_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "no_proxy",
  "all_proxy",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "GH_TOKEN",
  "GITHUB_TOKEN",
  "GH_ENTERPRISE_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_CONFIG_DIR",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
  "SystemRoot",
  "PATHEXT",
  "ComSpec",
  "TEMP",
  "TMP",
] as const

/** Settings that keep git non-interactive, unpaged and uncolored. */
const FORCED_ENV: Record<string, string> = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_PAGER: "cat",
  NO_COLOR: "1",
}

/** The variables of `GIT_PASSED_ENV` that are set in `process.env` now. */
export function passedEnv(): Record<string, string> {
  const env: Record<string, string> = {}
  for (const name of GIT_PASSED_ENV) {
    const value = process.env[name]
    if (value !== undefined) env[name] = value
  }
  return env
}

/**
 * The environment every git call gets: passed variables read from `process.env`
 * at call time, then the forced ones on top.
 */
export function gitEnv(): Record<string, string> {
  return { ...passedEnv(), ...FORCED_ENV }
}

/** Options for running a git command. */
export type GitOptions = {
  cwd: string
  signal?: AbortSignal
  /** Text written to git's stdin. */
  stdin?: string
  /** Stops the call after this many milliseconds; defaults to two minutes. */
  timeoutMs?: number
  /**
   * Whether hooks run. Defaults to true; `hooks: false` prepends
   * `-c core.hooksPath=/dev/null -c core.fsmonitor=false` to the arguments
   * (for the tools' own plumbing only). There is no other way to skip hooks;
   * never add `--no-verify` anywhere.
   */
  hooks?: boolean
}

function isSpawnNotFound(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT"
}

function versionParts(version: string): [number, number, number] {
  const parts = version.split(".").map((part) => Number.parseInt(part, 10))
  return [parts[0] ?? 0, parts[1] ?? 0, parts[2] ?? 0]
}

function isOlder(version: string, minimum: string): boolean {
  const have = versionParts(version)
  const need = versionParts(minimum)
  for (let i = 0; i < 3; i++) {
    const difference = have[i] - need[i]
    if (difference !== 0) return difference < 0
  }
  return false
}

function subcommand(args: string[]): string {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (arg === "-c" || arg === "-C") {
      i++
      continue
    }
    if (!arg.startsWith("-")) {
      return arg
    }
  }
  return args[0] ?? "command"
}

function stoppedError(args: string[], result: ExecResult, timeoutMs: number): ToolError | undefined {
  if (!result.signal && !result.timedOut) return undefined
  const command = subcommand(args)
  const message = result.timedOut
    ? `git ${command} timed out after ${timeoutMs / 1000} seconds and was stopped with ${result.signal ?? "SIGTERM"}.`
    : `git ${command} was stopped with ${result.signal}.`
  return new ToolError("git_error", message)
}

async function readGitVersion(): Promise<string> {
  let result: ExecResult
  try {
    result = await exec(["git", "--version"], { env: gitEnv(), timeoutMs: VERSION_CHECK_TIMEOUT_MS })
  } catch (error) {
    if (isSpawnNotFound(error)) throw new ToolError("git_missing", GIT_MISSING_MESSAGE, { cause: error })
    throw error
  }
  const stopped = stoppedError(["--version"], result, VERSION_CHECK_TIMEOUT_MS)
  if (stopped) throw stopped
  const version = /git version (\d+\.\d+(?:\.\d+)?)/.exec(result.stdout)?.[1]
  if (result.code !== 0 || !version) {
    throw new ToolError(
      "git_error",
      `Could not read the git version: ${result.stderr.trim() || result.stdout.trim() || `exit ${result.code}`}`,
    )
  }
  if (isOlder(version, MIN_GIT_VERSION)) {
    throw new ToolError("git_too_old", `git ${version} is older than ${MIN_GIT_VERSION}; update git.`)
  }
  return version
}

let gitCheck: Promise<string> | undefined

async function gitVersion(signal?: AbortSignal): Promise<string> {
  if (signal?.aborted) throw abortError(signal)
  gitCheck ??= readGitVersion().catch((error: unknown) => {
    gitCheck = undefined
    throw error
  })
  return gitCheck
}

/**
 * Checks once per process that git is installed and recent enough. A failed
 * check is not remembered, so a later call retries after the person fixes it.
 * The check itself ignores `signal`, so one caller's abort cannot fail the
 * others waiting on the same check.
 */
export async function ensureGit(signal?: AbortSignal): Promise<void> {
  await gitVersion(signal)
}

/**
 * Throws `git_too_old` naming `feature` when git is older than `minimum`, for
 * an option newer than `MIN_GIT_VERSION` that only some calls use.
 */
export async function requireGitVersion(minimum: string, feature: string, signal?: AbortSignal): Promise<void> {
  const version = await gitVersion(signal)
  if (isOlder(version, minimum)) {
    throw new ToolError("git_too_old", `git ${version} is older than ${minimum}, which ${feature} needs; update git.`)
  }
}

/** Forgets the version check. For tests only, which change `PATH` between cases. */
export function resetGitCheck(): void {
  gitCheck = undefined
}

/**
 * Maps a failed git command to a `git_error` carrying its exit code and output.
 * There is no text matching on the output because the locale is not forced, so
 * git's messages may be translated; a tool that needs to tell a failure apart
 * reads porcelain/plumbing output or exit codes instead.
 */
export function classifyGitFailure(args: string[], result: Pick<ExecResult, "code" | "stdout" | "stderr">): ToolError {
  const command = subcommand(args)
  const rawText = result.stderr.trim() || result.stdout.trim()
  const text = rawText.length > MAX_MESSAGE_LENGTH ? `${rawText.slice(0, MAX_MESSAGE_LENGTH)}…` : rawText
  const message = text
    ? `git ${command} failed (exit ${result.code}): ${text}`
    : `git ${command} failed (exit ${result.code}).`
  return new ToolError("git_error", message)
}

/**
 * Runs a git command and returns its result without throwing on non-zero exit codes.
 * Checks the working directory first, verifies git is available, and enforces
 * time limits.
 */
export async function gitResult(args: string[], options: GitOptions): Promise<ExecResult> {
  let stats: Stats
  try {
    stats = await stat(options.cwd)
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code
    if (code === "ENOENT" || code === "ENOTDIR") {
      throw new ToolError("not_found", `The working directory ${options.cwd} does not exist.`, { cause: error })
    }
    throw error
  }
  if (!stats.isDirectory()) {
    throw new ToolError("not_found", `The working directory ${options.cwd} is not a directory.`)
  }

  await ensureGit(options.signal)

  const timeoutMs = options.timeoutMs ?? DEFAULT_GIT_TIMEOUT_MS
  const prefix = options.hooks === false ? ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"] : []
  let result: ExecResult
  try {
    result = await exec(["git", ...prefix, ...args], {
      cwd: options.cwd,
      env: gitEnv(),
      stdin: options.stdin,
      signal: options.signal,
      timeoutMs,
    })
  } catch (error) {
    if (isSpawnNotFound(error)) {
      throw new ToolError("git_missing", GIT_MISSING_MESSAGE, { cause: error })
    }
    throw error
  }

  const stopped = stoppedError(args, result, timeoutMs)
  if (stopped) throw stopped

  return result
}

/**
 * Runs a git command, throws `classifyGitFailure` when it exits non-zero, and
 * returns stdout.
 */
export async function git(args: string[], options: GitOptions): Promise<string> {
  const result = await gitResult(args, options)
  if (result.code !== 0) {
    throw classifyGitFailure(args, result)
  }
  return result.stdout
}

/**
 * Classifies a failure from `rev-parse --show-toplevel`.
 * The untranslated config key `safe.directory` is checked on failure; the config
 * key is never translated, so this test holds in every locale.
 */
export function classifyRepositoryRootFailure(
  cwd: string,
  result: Pick<ExecResult, "code" | "stdout" | "stderr">,
): ToolError {
  if (result.stderr.includes("safe.directory")) {
    return classifyGitFailure(["rev-parse", "--show-toplevel"], result)
  }
  const stderr = result.stderr.trim()
  const message = stderr
    ? `${cwd} is not inside a git working tree. ${stderr}`
    : `${cwd} is not inside a git working tree.`
  return new ToolError("not_a_repository", message)
}

/**
 * Finds the absolute top level of the working tree containing `cwd`.
 * Runs `rev-parse --show-toplevel` with hooks disabled.
 */
export async function repositoryRoot(options: Omit<GitOptions, "stdin" | "hooks">): Promise<string> {
  const result = await gitResult(["rev-parse", "--show-toplevel"], { ...options, hooks: false })
  if (result.code === 0) {
    return result.stdout.trim()
  }
  throw classifyRepositoryRootFailure(options.cwd, result)
}
