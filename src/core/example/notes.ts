import { join, resolve } from "node:path"
import { z } from "zod"
import { ToolError } from "../errors"
import { isWithin } from "../paths"
import type { ToolContext } from "../tool"

export const NOTES_DIR = "notes"

export const NOTE_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/

export const noteName = z
  .string()
  .regex(
    NOTE_NAME_PATTERN,
    "A note name must start with a lowercase letter or digit and contain up to 64 lowercase letters, digits, or hyphens.",
  )
  .describe("The note's name (lowercase letters, numbers and hyphens; up to 64 characters).")

/** Resolves the absolute path to a note file within the working tree. */
export function notePath(cwd: string, name: string): string {
  return resolve(cwd, NOTES_DIR, `${name}.md`)
}

/** Refuses to run if the working directory is the tools' own installation directory. */
export async function assertCallerTree(ctx: Pick<ToolContext, "cwd" | "ownDir">): Promise<void> {
  if (ctx.ownDir && (await isWithin(ctx.cwd, ctx.ownDir))) {
    throw new ToolError(
      "invalid_argument",
      "The call runs in the directory the tools are installed in, not the caller's working tree; run it from the project instead.",
    )
  }
}
