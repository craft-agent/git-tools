import { chmodSync, copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { delimiter, join } from "node:path"
import { fileURLToPath } from "node:url"

const SCRIPT_SOURCE = fileURLToPath(new URL("./gh-script.mjs", import.meta.url))

/**
 * One canned reply. The first rule whose `match` (a regular expression tested
 * against the arguments joined by spaces) fits answers; `delayMs` holds the
 * answer back, for tests of time limits.
 */
export type GhRule = {
  match: string
  stdout?: string
  stderr?: string
  code?: number
  delayMs?: number
}

export type FakeGh = {
  dir: string
  /** The arguments of every call so far, oldest first. */
  calls(): string[][]
  /** Puts `PATH` back and removes the fake. */
  restore(): void
}

/**
 * Puts a fake `gh` first on `PATH`. It exits 1 for a call no rule matches.
 * Call `restore()` when the test ends.
 */
export function installFakeGh(rules: GhRule[]): FakeGh {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "fake-gh-")))
  const script = join(dir, "gh")
  copyFileSync(SCRIPT_SOURCE, script)
  chmodSync(script, 0o755)
  // The script has no extension, so a package.json makes Node read it as a module.
  writeFileSync(join(dir, "package.json"), JSON.stringify({ type: "module" }))
  writeFileSync(join(dir, "rules.json"), JSON.stringify(rules))
  writeFileSync(join(dir, "calls.log"), "")

  const originalPath = process.env.PATH
  process.env.PATH = originalPath === undefined ? dir : `${dir}${delimiter}${originalPath}`

  return {
    dir,
    calls: () =>
      readFileSync(join(dir, "calls.log"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[]),
    restore() {
      if (originalPath === undefined) delete process.env.PATH
      else process.env.PATH = originalPath
      rmSync(dir, { recursive: true, force: true })
    },
  }
}
