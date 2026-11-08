import { describe, expect, test } from "bun:test"
import { GIT_PASSED_ENV } from "./core/git"
import { PROJECT } from "./project"

/** The list Codex forwards to a plugin's server without being asked. */
const CODEX_DEFAULT_ENV = [
  "HOME",
  "LOGNAME",
  "PATH",
  "SHELL",
  "USER",
  "LANG",
  "LC_ALL",
  "TERM",
  "TMPDIR",
  "TZ",
] as const

describe("PROJECT.toolVariables", () => {
  test("every GIT_PASSED_ENV variable is in CODEX_DEFAULT_ENV or PROJECT.toolVariables", () => {
    for (const name of GIT_PASSED_ENV) {
      const forwarded =
        (CODEX_DEFAULT_ENV as readonly string[]).includes(name) ||
        (PROJECT.toolVariables as readonly string[]).includes(name)
      expect(forwarded).toBe(true)
    }
  })

  test("PROJECT.toolVariables contains nothing outside GIT_PASSED_ENV", () => {
    for (const name of PROJECT.toolVariables) {
      expect(GIT_PASSED_ENV as readonly string[]).toContain(name)
    }
  })
})
