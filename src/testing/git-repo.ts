/**
 * A git repository in a temporary directory for tests, with a bare repository as
 * `origin` and a home of its own, so the developer's global git config
 * (identity, signing, hooks paths, templates) cannot change a result.
 */

import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { git, type GitOptions, resetGitCheck } from "../core/git"

const TEMP_DIR_PREFIX = "git-repo-"

const GITCONFIG = `[user]
\tname = Test
\temail = test@example.com
[init]
\tdefaultBranch = main
[commit]
\tgpgsign = false
[tag]
\tgpgsign = false
`

export type TempRepo = {
  /** The working tree (realpath), on branch `main`. */
  dir: string
  /** The bare repository added as `origin` (realpath), or undefined when made without one. */
  remote: string | undefined
  /** The temporary HOME the repository's git calls see while it is open. */
  home: string
  /** Runs git in `dir` through the runner. */
  git(args: string[], options?: Omit<GitOptions, "cwd">): Promise<string>
  /** Writes a file relative to `dir`, creating parent directories. */
  write(path: string, content: string): void
  /** Writes `files` (path → content), stages everything with `add -A`, commits with `message`, returns the new HEAD sha. Hooks run as configured. */
  commit(message: string, files?: Record<string, string>): Promise<string>
  /** Restores HOME and XDG_CONFIG_HOME exactly as they were (deleting them if they were unset), calls resetGitCheck(), and removes every directory it made. Safe to call twice. */
  cleanup(): void
}

export type TempRepoOptions = {
  /** Add a bare `origin`; default true. */
  remote?: boolean
  /** Make one commit (`initial`, a README.md) on main and, with a remote, push it with upstream tracking; default true. */
  initialCommit?: boolean
}

/**
 * Creates a git repository in a temporary directory with its own HOME and optional bare remote.
 */
export async function tempRepo(options?: TempRepoOptions): Promise<TempRepo> {
  const withRemote = options?.remote ?? true
  const withInitialCommit = options?.initialCommit ?? true

  const rootDir = realpathSync(mkdtempSync(join(tmpdir(), TEMP_DIR_PREFIX)))
  const homeDir = join(rootDir, "home")
  const workDir = join(rootDir, "work")
  const remoteDir = withRemote ? join(rootDir, "origin.git") : undefined

  const originalHome = process.env.HOME
  const originalXdgConfigHome = process.env.XDG_CONFIG_HOME

  let cleanedUp = false
  const cleanup = (): void => {
    if (cleanedUp) return
    cleanedUp = true
    if (originalHome === undefined) {
      delete process.env.HOME
    } else {
      process.env.HOME = originalHome
    }
    if (originalXdgConfigHome === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalXdgConfigHome
    }
    resetGitCheck()
    rmSync(rootDir, { recursive: true, force: true })
  }

  process.env.HOME = homeDir
  delete process.env.XDG_CONFIG_HOME

  try {
    mkdirSync(homeDir, { recursive: true })
    mkdirSync(workDir, { recursive: true })
    writeFileSync(join(homeDir, ".gitconfig"), GITCONFIG)

    await git(["init"], { cwd: workDir })

    if (withRemote && remoteDir) {
      mkdirSync(remoteDir, { recursive: true })
      await git(["init", "--bare"], { cwd: remoteDir })
      await git(["remote", "add", "origin", remoteDir], { cwd: workDir })
    }

    const write = (path: string, content: string): void => {
      const fullPath = join(workDir, path)
      mkdirSync(dirname(fullPath), { recursive: true })
      writeFileSync(fullPath, content)
    }

    const commit = async (message: string, files?: Record<string, string>): Promise<string> => {
      if (files) {
        for (const [path, content] of Object.entries(files)) {
          write(path, content)
        }
      }
      await git(["add", "-A"], { cwd: workDir })
      await git(["commit", "-m", message], { cwd: workDir })
      const head = await git(["rev-parse", "HEAD"], { cwd: workDir })
      return head.trim()
    }

    if (withInitialCommit) {
      await commit("initial", { "README.md": "# Test\n" })
      if (withRemote) {
        await git(["push", "-u", "origin", "main"], { cwd: workDir })
      }
    }

    return {
      dir: workDir,
      remote: remoteDir,
      home: homeDir,
      git: (args, opts) => git(args, { ...opts, cwd: workDir }),
      write,
      commit,
      cleanup,
    }
  } catch (error) {
    cleanup()
    throw error
  }
}
