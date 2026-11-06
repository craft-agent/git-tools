import { z } from "zod"
import { ToolError, abortError, defineTool, isWithin, type ToolSpec, type WriteClass } from "../core"
import type { EntryProfile } from "../entry/profile"
import { runCli, type CliIo } from "./cli"

/** Fixtures the command-line tests share. */

/** The profile the test command lines are built with: `alpha` is on by default, `beta` is not. */
export const PROFILE: EntryProfile = {
  envPrefix: "DEMO",
  toolsets: { names: ["alpha", "beta"], defaults: ["alpha"] },
}

const input = z.object({
  area: z.string().describe("The area the call works in.").optional(),
  count: z.number().int().optional(),
})
const output = z.object({
  tool: z.string(),
  cwd: z.string(),
  count: z.number().optional(),
  own_dir: z.string().optional(),
})
const writeInput = input.extend({ parent: z.string().optional() })

export const READ_ID = "demo_thing_read"
export const ADD_ID = "demo_thing_comment"
export const ADMIN_ID = "demo_other_publish"
export const MISSING_ID = "demo_thing_close"
export const BROKEN_ID = "demo_thing_reopen"
export const SLOW_ID = "demo_thing_lock"

/**
 * The add fixture writes to its `area` (the working directory without one) and
 * its `parent`; in the install directory it cannot tell without an `area`.
 */
async function areaTargets(args: z.output<typeof writeInput>, ctx: { cwd: string; ownDir?: string }) {
  if (args.area === undefined && ctx.ownDir !== undefined && (await isWithin(ctx.cwd, ctx.ownDir))) {
    throw new Error("the install directory is not a project")
  }
  return [args.area ?? ctx.cwd, ...(args.parent === undefined ? [] : [args.parent])]
}

function fixture(id: string, toolset: string, writeClass: WriteClass): ToolSpec {
  return defineTool({
    id,
    title: `Title of ${id}`,
    description: `Description of ${id}`,
    toolset,
    class: writeClass,
    ...(id === ADD_ID && { targets: areaTargets }),
    input: id === ADD_ID ? writeInput : input,
    output,
    async execute(args, ctx) {
      return { tool: id, cwd: ctx.cwd, count: args.count, own_dir: ctx.ownDir }
    },
  })
}

function failingWith(id: string, writeClass: WriteClass, fail: (signal?: AbortSignal) => Promise<never>) {
  return defineTool({
    id,
    title: id,
    description: id,
    toolset: "alpha",
    class: writeClass,
    input,
    output,
    execute: (_args, ctx) => fail(ctx.signal),
  })
}

export const specs: ToolSpec[] = [
  fixture(READ_ID, "alpha", "read"),
  fixture(ADD_ID, "alpha", "add"),
  fixture(ADMIN_ID, "beta", "administrative"),
  failingWith(MISSING_ID, "overwrite", async () => {
    throw new ToolError("not_found", "No such thing.")
  }),
  failingWith(BROKEN_ID, "overwrite", async () => {
    throw new TypeError("boom")
  }),
  failingWith(SLOW_ID, "idempotent", (signal) => {
    return new Promise((_resolve, reject) => {
      if (signal?.aborted) reject(abortError(signal))
      signal?.addEventListener("abort", () => reject(abortError(signal)))
    })
  }),
]

export type Run = { code: number; stdout: string; stderr: string }

/** Runs the command line over the fixture specs and collects what it writes. */
export async function cli(argv: string[], stdin = "", overrides: Partial<CliIo> = {}): Promise<Run> {
  let stdout = ""
  let stderr = ""
  const code = await runCli(argv, {
    specs,
    env: {},
    profile: PROFILE,
    readStdin: async () => stdin,
    stdout: (text) => (stdout += text),
    stderr: (text) => (stderr += text),
    ...overrides,
  })
  return { code, stdout, stderr }
}

export const json = (run: Run): any => JSON.parse(run.stdout)
