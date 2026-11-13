import { expect } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"
import { isToolError, type GrantContext } from "../core"
import { NOTE_OPTION } from "./options.testing"
import type { EntryProfile } from "./profile"

/** Fixtures the settings tests share. */

export const profile: EntryProfile = {
  name: "demo-tools",
  envPrefix: "DEMO",
  toolsets: { names: ["alpha", "beta", "gamma"], defaults: ["alpha"] },
  options: { [NOTE_OPTION]: "text" },
}

/** The grants' context of settings that name no grant setting, read from an environment without `HOME` or `XDG_STATE_HOME`. */
export const DEFAULT_GRANTS: GrantContext = {
  unattended: false,
  dir: join(homedir(), ".local", "state", profile.name, "grants"),
  key: undefined,
}

export function failure(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    return error as Error
  }
  throw new Error("expected the settings to be rejected")
}
