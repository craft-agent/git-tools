import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PROFILE, fixtureSpecs } from "./testing"
import type { V2Context, V2Skill } from "./types"
import { createV2Setup } from "./v2"

let dir: string

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "skills-"))
  await skill("free", "")
  await skill("alpha-skill", "metadata:\n  toolset: alpha\n")
  await skill("beta-skill", "metadata:\n  toolset: beta\n")
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function skill(name: string, extra: string): Promise<void> {
  await mkdir(join(dir, name))
  await writeFile(join(dir, name, "SKILL.md"), `---\nname: ${name}\n${extra}---\nBody\n`)
}

async function registeredSkills(options?: Record<string, unknown>): Promise<string[]> {
  const skills: V2Skill[] = []
  const ctx: V2Context = {
    options,
    session: {
      async get() {
        return {}
      },
    },
    permission: { async assert() {} },
    tool: { transform: async (callback) => callback({ add: () => {} }) },
    skill: { transform: async (callback) => callback({ add: (added) => skills.push(added) }) },
  }
  await createV2Setup(fixtureSpecs([]), { env: {}, profile: PROFILE, skillsDir: dir })(ctx)
  return skills.map(({ id }) => id)
}

describe("V2 skills follow the selected toolsets", () => {
  test("the default options register the alpha-linked and the unlinked skills", async () => {
    expect(await registeredSkills()).toEqual(["alpha-skill", "free"])
  })

  test('toolsets "all" registers every skill', async () => {
    expect(await registeredSkills({ toolsets: "all" })).toEqual(["alpha-skill", "beta-skill", "free"])
  })

  test("an option that removes every tool of a toolset hides its skill", async () => {
    expect(await registeredSkills({ toolsets: "all", read_only: true })).toEqual(["alpha-skill", "free"])
    expect(await registeredSkills({ toolsets: "all", exclude_tools: ["demo_other_delete"] })).toEqual([
      "alpha-skill",
      "free",
    ])
    expect(await registeredSkills({ toolsets: ["beta"] })).toEqual(["beta-skill", "free"])
  })
})
