import { expect } from "bun:test"
import { isToolError } from "../core"
import type { EntryProfile } from "./profile"

/** Fixtures the settings tests share. */

export const profile: EntryProfile = {
  envPrefix: "DEMO",
  toolsets: { names: ["alpha", "beta", "gamma"], defaults: ["alpha"] },
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
