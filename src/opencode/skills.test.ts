import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { PROJECT } from "../project"
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

describe("loadSkills", () => {
  test("reads the name, description and body of a skill", async () => {
    const path = await skillFile(
      "triage",
      "---\nname: thing-triage\ndescription: Sort the things\n---\n# Triage\n\nSteps.\n",
    )
    expect(await loadSkills(dir)).toEqual([
      {
        id: "thing-triage",
        name: "thing-triage",
        description: "Sort the things",
        path,
        content: "# Triage\n\nSteps.\n",
      },
    ])
  })

  test("takes a URL as well as a path", async () => {
    await skillFile("a", "---\nname: a\n---\nBody")
    expect((await loadSkills(pathToFileURL(`${dir}/`))).map((skill) => skill.id)).toEqual(["a"])
  })

  test("falls back to the folder name when the frontmatter has no name", async () => {
    await skillFile("thing-sync", "---\ndescription: Keep the things in step\n---\nBody\n")
    const [skill] = await loadSkills(dir)
    expect(skill).toMatchObject({ id: "thing-sync", name: "thing-sync", description: "Keep the things in step" })
  })

  test("a file without frontmatter is all content, with no description", async () => {
    const path = await skillFile("plain", "# Just text\n")
    expect(await loadSkills(dir)).toEqual([{ id: "plain", name: "plain", path, content: "# Just text\n" }])
  })

  test("an unclosed frontmatter is content", async () => {
    await skillFile("open", "---\nname: x\nBody\n")
    const [skill] = await loadSkills(dir)
    expect(skill).toMatchObject({ id: "open", content: "---\nname: x\nBody\n" })
  })

  test("reads quoted values and CRLF files, and ignores a trailing comment", async () => {
    await skillFile("q1", "---\r\nname: \"quoted: name\"\r\ndescription: 'It''s fine'\r\n---\r\nBody\r\n")
    await skillFile("q2", '---\nname: plain-name # a comment\ndescription: "a \\"b\\""\n---\nBody')
    const skills = await loadSkills(dir)
    expect(skills.map(({ id, description, content }) => ({ id, description, content }))).toEqual([
      { id: "quoted: name", description: "It's fine", content: "Body\r\n" },
      { id: "plain-name", description: 'a "b"', content: "Body" },
    ])
  })

  test("reads a quoted value followed by a comment", async () => {
    await skillFile("c1", "---\nname: \"x\" # c\ndescription: 'y' # d\n---\nBody")
    await skillFile("c2", '---\nname: "z"extra\n---\nBody')
    const skills = await loadSkills(dir)
    expect(skills.map(({ id, description }) => ({ id, description }))).toEqual([
      { id: "x", description: "y" },
      { id: "c2", description: undefined },
    ])
  })

  test("keeps the first of two skills with the same id, in folder order", async () => {
    const first = await skillFile("a-first", "---\nname: same\n---\nFirst")
    await skillFile("b-second", "---\nname: same\n---\nSecond")
    await skillFile("same", "Third")
    const skills = await loadSkills(dir)
    expect(skills.map(({ id, path, content }) => ({ id, path, content }))).toEqual([
      { id: "same", path: first, content: "First" },
    ])
  })

  test("skips a key whose value is a block, a list or empty", async () => {
    await skillFile("blocks", "---\nname: >\n  folded\ndescription: |\n  literal\n---\nBody")
    await skillFile("empty", "---\nname:\ndescription: [a, b]\n---\nBody")
    const skills = await loadSkills(dir)
    expect(skills.map(({ id, description }) => ({ id, description }))).toEqual([
      { id: "blocks", description: undefined },
      { id: "empty", description: undefined },
    ])
  })

  test("skips a folder without a SKILL.md and a loose file, and sorts by folder", async () => {
    await mkdir(join(dir, "no-skill"))
    await writeFile(join(dir, "README.md"), "text")
    await skillFile("b", "---\nname: b\n---\n")
    await skillFile("a", "---\nname: a\n---\n")
    expect((await loadSkills(dir)).map((skill) => skill.id)).toEqual(["a", "b"])
  })

  test("an empty or missing directory gives no skills", async () => {
    expect(await loadSkills(dir)).toEqual([])
    expect(await loadSkills(join(dir, "missing"))).toEqual([])
  })
})

describe("the package's skills", () => {
  test("each loads under its folder's name, with a description and a body", async () => {
    const shipped = await loadSkills(new URL("../../skills/", import.meta.url))
    for (const skill of shipped) {
      expect(skill.path).toEndWith(join(skill.id, "SKILL.md"))
      expect(skill.description?.length ?? 0).toBeGreaterThan(0)
      expect(skill.description?.length ?? 0).toBeLessThanOrEqual(1024)
      expect(skill.content.trim().length).toBeGreaterThan(0)
    }
  })

  test("each linked skill names one of the package's toolsets", async () => {
    const shipped = await readSkills(new URL("../../skills/", import.meta.url))
    const stray = shipped
      .filter(({ toolset }) => toolset !== undefined && !PROJECT.toolsets.includes(toolset))
      .map(({ skill, toolset }) => `${skill.id}: ${toolset}`)
    expect(stray).toEqual([])
  })
})
