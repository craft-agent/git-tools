import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadSkills, readSkills } from "./skills"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skills-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function skillFile(folder: string, text: string): Promise<string> {
  await mkdir(join(dir, folder), { recursive: true })
  const path = join(dir, folder, "SKILL.md")
  await writeFile(path, text)
  return path
}

async function linkOf(frontmatter: string): Promise<string | undefined> {
  await skillFile("s", `---\n${frontmatter}\n---\nBody`)
  return (await readSkills(dir))[0]?.toolset
}

describe("a skill's toolset link", () => {
  test("reads metadata.toolset as a plain or a quoted value", async () => {
    expect(await linkOf("name: s\nmetadata:\n  toolset: notes")).toBe("notes")
    expect(await linkOf('name: s\nmetadata:\n  toolset: "notes" # c')).toBe("notes")
    expect(await linkOf("name: s\nmetadata:\n\ttoolset: 'notes'")).toBe("notes")
  })

  test("reads a CRLF frontmatter like an LF one", async () => {
    expect(await linkOf("name: s\r\nmetadata: # c\r\n  toolset: notes\r\ndescription: d\r\n")).toBe("notes")
  })

  test("a comment or a blank line inside the block does not end it", async () => {
    expect(await linkOf("name: s\nmetadata:\n\n  # about\n   \n  toolset: notes")).toBe("notes")
  })

  test("the last valid toolset wins", async () => {
    expect(await linkOf("name: s\nmetadata:\n  toolset: a\n  toolset: b\n  toolset: [c]")).toBe("b")
  })

  test("a following top-level key ends the block and is still read", async () => {
    await skillFile("s", "---\nmetadata:\n  other: x\ndescription: d\n---\nBody")
    const [found] = await readSkills(dir)
    expect(found?.skill.description).toBe("d")
    expect(found?.toolset).toBeUndefined()
  })

  test("a toolset after the block ended is no link", async () => {
    expect(await linkOf("name: s\nmetadata:\n  other: x\ntoolset: notes")).toBeUndefined()
  })

  test("a flow value, a top-level toolset and a nested toolset give no link", async () => {
    expect(await linkOf("name: s\nmetadata: {toolset: notes}")).toBeUndefined()
    expect(await linkOf("name: s\ntoolset: notes")).toBeUndefined()
    expect(await linkOf("name: s\nmetadata:\n  group:\n    toolset: notes")).toBeUndefined()
    expect(await linkOf("name: s\nmetadata:\n  toolset: [notes]")).toBeUndefined()
  })

  test("indented name and description inside metadata are not the skill's", async () => {
    await skillFile("s", "---\nmetadata:\n  name: x\n  description: y\n  toolset: notes\n---\nBody")
    const [found] = await readSkills(dir)
    expect(found?.skill.id).toBe("s")
    expect(found?.skill.description).toBeUndefined()
    expect(found?.toolset).toBe("notes")
  })
})

describe("loadSkills with toolsets", () => {
  async function seed() {
    await skillFile("a", "---\nname: free\n---\nBody")
    await skillFile("b", "---\nname: on\nmetadata:\n  toolset: notes\n---\nBody")
    await skillFile("c", "---\nname: off\nmetadata:\n  toolset: other\n---\nBody")
  }

  test("keeps unlinked skills and those linked to a given toolset", async () => {
    await seed()
    const skills = await loadSkills(dir, new Set(["notes"]))
    expect(skills.map((skill) => skill.id)).toEqual(["free", "on"])
    expect(skills.every((skill) => !("toolset" in skill))).toBe(true)
  })

  test("drops every linked skill for an empty set, and keeps all without one", async () => {
    await seed()
    expect((await loadSkills(dir, new Set())).map((skill) => skill.id)).toEqual(["free"])
    expect((await loadSkills(dir)).map((skill) => skill.id)).toEqual(["free", "on", "off"])
  })

  test("a skill filtered off still claims its id", async () => {
    await skillFile("a", "---\nname: same\nmetadata:\n  toolset: other\n---\nA")
    await skillFile("b", "---\nname: same\n---\nB")
    expect(await loadSkills(dir, new Set(["notes"]))).toEqual([])
  })
})
