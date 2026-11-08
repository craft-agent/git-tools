import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { ToolError, defineTool, isWithin, type ToolSpec, type Translations, type WriteClass } from "../core"
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
export const LABEL_ID = "demo_thing_label"
export const ADMIN_ID = "demo_other_delete"
export const FAILING_ID = "demo_thing_close"

/** Japanese words for the add fixture's title and for the label fixture's headline, fact label and text label. */
export const TRANSLATIONS: Translations = {
  ja: {
    [`Title of ${ADD_ID}`]: "追加ツール",
    "Label the area {area}": "エリア {area} にラベルを付ける",
    Area: "エリア",
    Body: "本文",
  },
}

/** The approval prompts of the add and label fixtures for `north`, in English and through `TRANSLATIONS`. */
export const ENGLISH_ADD = `Title of ${ADD_ID}\n\n--- Details ---\n\nTarget: north`
export const JAPANESE_ADD = "追加ツール\n\n--- 詳細 ---\n\n対象: north"
export const ENGLISH_LABEL =
  'Label the area "north"\n\n--- Details ---\n\nTarget: north\nArea: north\n\n--- Body ---\n\nBody<U+202E>'
export const JAPANESE_LABEL =
  'エリア "north" にラベルを付ける\n\n--- 詳細 ---\n\n対象: north\nエリア: north\n\n--- 本文 ---\n\nBody<U+202E>'

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
 * A read and two add tools of `alpha`, an administrative tool of `beta`, and an
 * `alpha` tool that fails with `not_found`; `events` logs each execution.
 */
export function fixtureSpecs(events: string[]): ToolSpec[] {
  return [
    fixture(READ_ID, "alpha", "read", events),
    fixture(ADD_ID, "alpha", "add", events),
    defineTool({
      ...fixture(LABEL_ID, "alpha", "add", events),
      input: writeInput,
      describe: (args) => ({
        headline: { text: "Label the area {area}", values: { area: args.area ?? "here" } },
        facts: [{ label: "Area", value: args.area ?? "here" }],
        text: { label: "Body", body: "Body\u202E" },
      }),
    }),
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
