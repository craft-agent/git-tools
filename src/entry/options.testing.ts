import { z } from "zod"
import { defineTool, type ToolSpec } from "../core"

/** A tool that shows the tool options its call got, for the tests of every entry point. */

/** The tool option the test profiles carry. */
export const NOTE_OPTION = "note_text"
export const NOTE_ID = "demo_note_stamp"

/** An add tool of `alpha` that returns `ctx.options` and shows the note option as a fact of its description. */
export const noteSpec: ToolSpec = defineTool({
  id: NOTE_ID,
  title: NOTE_ID,
  description: NOTE_ID,
  toolset: "alpha",
  class: "add",
  targets: () => ["north"],
  describe: (_args, ctx) => ({ facts: [{ label: "Note", value: ctx.options?.[NOTE_OPTION] ?? "none" }] }),
  input: z.object({}),
  output: z.object({ options: z.record(z.string(), z.string()) }),
  async execute(_args, ctx) {
    return { options: { ...ctx.options } }
  },
})
