import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ToolError } from "../errors"
import { writeTargets } from "../targets"
import { annotations, invoke } from "../tool"
import { exampleNoteCreate } from "./create"
import { notePath } from "./notes"

let workDir: string
let ownDir: string

beforeEach(async () => {
  workDir = await mkdtemp(join(tmpdir(), "example-create-work-"))
  ownDir = await mkdtemp(join(tmpdir(), "example-create-own-"))
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

describe("exampleNoteCreate: annotations", () => {
  test("publishes add class annotations", () => {
    expect(annotations(exampleNoteCreate)).toEqual({
      title: "Create a note",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })
})

describe("exampleNoteCreate: create", () => {
  test("creates note file, makes directory if missing, and returns name, relative path, and bytes", async () => {
    const text = "# New Project\n\nStarting out."
    const result = await invoke(exampleNoteCreate, { name: "project-plan", text }, { cwd: workDir })

    expect(result).toEqual({
      name: "project-plan",
      path: "notes/project-plan.md",
      bytes: Buffer.byteLength(text, "utf8"),
    })

    const written = await readFile(notePath(workDir, "project-plan"), "utf8")
    expect(written).toBe(text)
  })

  test("creating twice with same name throws invalid_argument", async () => {
    await invoke(exampleNoteCreate, { name: "once", text: "First" }, { cwd: workDir })
    const error = await thrown(invoke(exampleNoteCreate, { name: "once", text: "Second" }, { cwd: workDir }))

    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain('A note named "once" already exists; pick another name.')
  })
})

describe("exampleNoteCreate: targets", () => {
  test("writeTargets resolves to the absolute note path", async () => {
    const targets = await writeTargets(exampleNoteCreate, { name: "target-note", text: "content" }, { cwd: workDir })
    expect(targets).toEqual([notePath(workDir, "target-note")])
  })

  test("writeTargets yields * for invalid arguments", async () => {
    const targets = await writeTargets(exampleNoteCreate, { name: "Invalid_Name", text: "content" }, { cwd: workDir })
    expect(targets).toEqual(["*"])
  })
})

describe("exampleNoteCreate: validation and tree checks", () => {
  test("invalid note name is rejected by invoke as invalid_argument", async () => {
    const error = await thrown(invoke(exampleNoteCreate, { name: "UPPERCASE", text: "Content" }, { cwd: workDir }))
    expect(error.code).toBe("invalid_argument")
  })

  test("unknown argument is rejected by invoke as invalid_argument", async () => {
    const error = await thrown(
      invoke(exampleNoteCreate, { name: "good-name", text: "Content", unknownField: 123 }, { cwd: workDir }),
    )
    expect(error.code).toBe("invalid_argument")
  })

  test("running in ownDir throws invalid_argument", async () => {
    const error = await thrown(
      invoke(exampleNoteCreate, { name: "test-note", text: "Content" }, { cwd: ownDir, ownDir }),
    )
    expect(error.code).toBe("invalid_argument")
    expect(error.message).toContain("runs in the directory the tools are installed in")
  })
})
