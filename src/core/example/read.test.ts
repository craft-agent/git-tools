import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolError } from "../errors"
import { annotations, invoke } from "../tool"
import { NOTES_DIR } from "./notes"
import { exampleNoteRead } from "./read"

let workDir: string
let ownDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "example-read-work-"))
  ownDir = await mkdtemp(join(tmpdir(), "example-read-own-"))
})

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true })
  await rm(ownDir, { recursive: true, force: true })
})

async function thrown(promise: Promise<unknown>): Promise<ToolError> {
  try {
    await promise
    throw new Error("Expected promise to reject")
  } catch (error) {
    if (error instanceof ToolError) return error
    throw error
  }
}

describe("exampleNoteRead: annotations", () => {
  test("publishes read class annotations", () => {
    expect(annotations(exampleNoteRead)).toEqual({
      title: "Read notes",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })
})

describe("exampleNoteRead: list", () => {
  test("returns empty list when notes directory is missing", async () => {
    const result = await invoke(exampleNoteRead, { method: "list" }, { cwd: workDir })
    expect(result).toEqual({ notes: [] })
  })

  test("returns empty list when notes directory is empty", async () => {
    await mkdir(join(workDir, NOTES_DIR))
    const result = await invoke(exampleNoteRead, { method: "list" }, { cwd: workDir })
    expect(result).toEqual({ notes: [] })
  })

  test("filters non-notes and sorts matching notes by name", async () => {
    const dir = join(workDir, NOTES_DIR)
    await mkdir(dir)
    await writeFile(join(dir, "zebra.md"), "Zebra content")
    await writeFile(join(dir, "alpha.md"), "Alpha")
    await writeFile(join(dir, "ignore.txt"), "Not markdown")
    await writeFile(join(dir, "-invalid.md"), "Starts with hyphen")
    await writeFile(join(dir, "Invalid-Caps.md"), "Has uppercase")

    const result = await invoke(exampleNoteRead, { method: "list" }, { cwd: workDir })
    expect(result).toEqual({
      notes: [
        { name: "alpha", bytes: 5 },
        { name: "zebra", bytes: 13 },
      ],
    })
  })
})

describe("exampleNoteRead: view", () => {
  test("reads note content by name", async () => {
    const dir = join(workDir, NOTES_DIR)
    await mkdir(dir)
    await writeFile(join(dir, "meeting-notes.md"), "# Meeting\n\nNotes here.")

    const result = await invoke(exampleNoteRead, { method: "view", name: "meeting-notes" }, { cwd: workDir })
    expect(result).toEqual({
      name: "meeting-notes",
      text: "# Meeting\n\nNotes here.",
    })
  })

  test("missing file throws not_found", async () => {
    const error = await thrown(invoke(exampleNoteRead, { method: "view", name: "missing" }, { cwd: workDir }))
    expect(error.code).toBe("not_found")
    expect(error.message).toContain('Note "missing" not found.')
  })

  test("view without name throws invalid_argument", async () => {
    const error = await thrown(invoke(exampleNoteRead, { method: "view" }, { cwd: workDir }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain('Method "view" requires `name`.')
  })
})

describe("exampleNoteRead: validation and tree checks", () => {
  test("invalid note name is rejected by invoke as invalid_argument", async () => {
    const error = await thrown(invoke(exampleNoteRead, { method: "view", name: "-bad-name" }, { cwd: workDir }))
    expect(error.code).toBe("invalid_argument")
  })

  test("unknown argument is rejected by invoke as invalid_argument", async () => {
    const error = await thrown(invoke(exampleNoteRead, { method: "list", extra: true }, { cwd: workDir }))
    expect(error.code).toBe("invalid_argument")
  })

  test("running in ownDir throws invalid_argument", async () => {
    const error = await thrown(invoke(exampleNoteRead, { method: "list" }, { cwd: ownDir, ownDir }))
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("runs in the directory the tools are installed in")
  })
})
