import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { ToolError, defineTool, isWithin, type ToolSpec, type WriteClass } from "../core"
import type { EntryProfile } from "../entry/profile"

/** Fixtures the OpenCode plugin tests share. */

/** The profile the test plugins are built with: `alpha` is on by default, `beta` is not. */
export const PROFILE: EntryProfile = {
  envPrefix: "DEMO",
  toolsets: { names: ["alpha", "beta"], defaults: ["alpha"] },
}

export const toolInput = z.object({
  area: z.string().describe("The area the call works in.").optional(),
  count: z.number().int().describe("How many.").optional(),
})
export const toolOutput = z.object({
  tool: z.string(),
  cwd: z.string(),
  count: z.number().optional(),
  own_dir: z.string().optional(),
})

/** What a write fixture takes beyond a read one: a second area it may write to. */
const writeInput = toolInput.extend({ extra_area: z.string().optional() })

export const READ_ID = "demo_thing_read"
export const ADD_ID = "demo_thing_create"
export const ADMIN_ID = "demo_other_delete"
export const FAILING_ID = "demo_thing_close"

/**
 * A write fixture writes to its `area` (the working directory without one) and
 * its `extra_area`; without an `area` it cannot tell in the install directory.
 */
async function writeTargets(args: z.output<typeof writeInput>, ctx: { cwd: string; ownDir?: string }) {
  if (args.area === undefined && ctx.ownDir !== undefined && (await isWithin(ctx.cwd, ctx.ownDir))) {
    throw new Error("the install directory is not a project")
  }
  return [args.area ?? ctx.cwd, ...(args.extra_area === undefined ? [] : [args.extra_area])]
}

function fixture(id: string, toolset: string, writeClass: WriteClass, events: string[]): ToolSpec {
  return defineTool({
    id,
    title: `Title of ${id}`,
    description: `Description of ${id}`,
    toolset,
    class: writeClass,
    ...(writeClass === "read" ? {} : { targets: writeTargets }),
    input: writeClass === "read" ? toolInput : writeInput,
    output: toolOutput,
    async execute(args, ctx) {
      events.push(`execute:${id}`)
      return { tool: id, cwd: ctx.cwd, count: args.count, own_dir: ctx.ownDir }
    },
  })
}

/**
 * A read and an add tool of `alpha`, an administrative tool of `beta`, and an
 * `alpha` tool that fails with `not_found`; `events` logs each execution.
 */
export function fixtureSpecs(events: string[]): ToolSpec[] {
  return [
    fixture(READ_ID, "alpha", "read", events),
    fixture(ADD_ID, "alpha", "add", events),
    fixture(ADMIN_ID, "beta", "administrative", events),
    defineTool({
      id: FAILING_ID,
      title: FAILING_ID,
      description: FAILING_ID,
      toolset: "alpha",
      class: "overwrite",
      input: toolInput,
      output: toolOutput,
      async execute() {
        throw new ToolError("not_found", "No such thing.")
      },
    }),
  ]
}

/** A new directory, by real path, that `cleanups` removes. */
export function tempDir(cleanups: (() => void)[]): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), "opencode-dir-")))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}
