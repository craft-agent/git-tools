import { mkdir, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { ToolError } from "../errors"
import { defineTool } from "../tool"
import { assertCallerTree, noteName, notePath, NOTES_DIR } from "./notes"

const input = z.object({
  name: noteName,
  text: z.string().max(100_000).describe("The content of the note in Markdown."),
})

const output = z.object({
  name: z.string().describe("The note's name."),
  path: z.string().describe("The path to the note relative to the working tree."),
  bytes: z.number().int().describe("The number of bytes written."),
})

export const exampleNoteCreate = defineTool({
  id: "example_note_create",
  title: "Create a note",
  description: "Create a note in the working tree's notes/ folder. Refuses to overwrite an existing note.",
  toolset: "notes",
  class: "add",
  targets: (args, ctx) => [notePath(ctx.cwd, args.name)],
  input,
  output,
  async execute(args, ctx) {
    await assertCallerTree(ctx)
    await mkdir(join(ctx.cwd, NOTES_DIR), { recursive: true })
    const target = notePath(ctx.cwd, args.name)
    try {
      await writeFile(target, args.text, { encoding: "utf8", flag: "wx" })
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new ToolError("invalid_argument", `A note named "${args.name}" already exists; pick another name.`)
      }
      throw error
    }
    return {
      name: args.name,
      path: `${NOTES_DIR}/${args.name}.md`,
      bytes: Buffer.byteLength(args.text, "utf8"),
    }
  },
})
