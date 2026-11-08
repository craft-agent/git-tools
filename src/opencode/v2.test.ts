import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import { ADD_ID, ADMIN_ID, FAILING_ID, LABEL_ID, PROFILE, READ_ID, fixtureSpecs, tempDir } from "./testing"
import type { V2Context, V2PermissionRequest, V2Skill, V2Tool } from "./types"
import { createV2Setup } from "./v2"

const SESSION_ID = "ses_1"
const DEFAULT_DIRECTORY = "/work/project"

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type FakeOptions = {
  options?: Record<string, unknown>
  /** What `session.get` resolves to (a session in `/work/project` when absent); `null` makes it reject. */
  location?: { directory?: string } | null
  /** The `ownDir` the plugin is built with. */
  ownDir?: string
  /** Makes `permission.assert` reject with this error. */
  deny?: Error
  events?: string[]
}

function fakeContext(fake: FakeOptions = {}) {
  const events = fake.events ?? []
  const tools = new Map<string, V2Tool>()
  const skills: V2Skill[] = []
  const asserts: V2PermissionRequest[] = []
  const ctx: V2Context = {
    options: fake.options,
    session: {
      async get() {
        if (fake.location === null) throw new Error("no such session")
        return { location: fake.location ?? { directory: DEFAULT_DIRECTORY } }
      },
    },
    permission: {
      async assert(input) {
        asserts.push(input)
        events.push(`assert:${input.action}`)
        if (fake.deny) throw fake.deny
      },
    },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async (callback) => callback({ add: (skill) => skills.push(skill) }) },
  }
  return { ctx, tools, skills, asserts, events }
}

async function setUp(fake: FakeOptions = {}, env: Record<string, string | undefined> = {}) {
  const events = fake.events ?? []
  const fakeCtx = fakeContext({ ...fake, events })
  await createV2Setup(fixtureSpecs(events), { env, profile: PROFILE, ownDir: fake.ownDir })(fakeCtx.ctx)
  return fakeCtx
}

const signal = new AbortController().signal

describe("V2 setup", () => {
  test("registers the default toolsets with the spec's name, description and schemas", async () => {
    const { tools } = await setUp()
    expect([...tools.keys()]).toEqual([READ_ID, ADD_ID, LABEL_ID, FAILING_ID])
    const read = tools.get(READ_ID)!
    expect(read.description).toBe(`Description of ${READ_ID}`)
    expect(z.toJSONSchema(read.input, { io: "input" }).additionalProperties).toBe(false)
    expect(Object.keys(read.input.shape)).toEqual(["area", "count"])
    expect(Object.keys(read.output.shape)).toEqual(["tool", "cwd", "count", "own_dir"])
  })

  test("takes toolsets, read_only and tools from the options", async () => {
    expect([...(await setUp({ options: { toolsets: "all" } })).tools.keys()]).toContain(ADMIN_ID)
    expect([...(await setUp({ options: { toolsets: ["beta"] } })).tools.keys()]).toEqual([ADMIN_ID])
    expect([...(await setUp({ options: { read_only: true, toolsets: "all" } })).tools.keys()]).toEqual([READ_ID])
    expect([...(await setUp({ options: { tools: [ADMIN_ID], exclude_tools: [ADD_ID] } })).tools.keys()]).toEqual([
      READ_ID,
      LABEL_ID,
      ADMIN_ID,
      FAILING_ID,
    ])
  })

  test("falls back to the environment, and an option wins over it", async () => {
    expect([...(await setUp({}, { DEMO_READ_ONLY: "true" })).tools.keys()]).toEqual([READ_ID])
    expect([...(await setUp({ options: { read_only: false } }, { DEMO_READ_ONLY: "true" })).tools.keys()]).toEqual([
      READ_ID,
      ADD_ID,
      LABEL_ID,
      FAILING_ID,
    ])
  })

  test("rejects an unknown toolset, a wrong option type and an unknown option", async () => {
    await expect(setUp({ options: { toolsets: ["bogus"] } })).rejects.toThrow('Unknown toolset "bogus"')
    await expect(setUp({ options: { read_only: "yes" } })).rejects.toThrow('Option "read_only"')
    await expect(setUp({ options: { toolsets: 3 } })).rejects.toThrow('Option "toolsets"')
    await expect(setUp({ options: { tools: READ_ID } })).rejects.toThrow('Option "tools"')
    await expect(setUp({ options: { exclude_tools: [1] } })).rejects.toThrow('Option "exclude_tools"')
    await expect(setUp({ options: { readonly: true } })).rejects.toThrow('Unknown option "readonly"')
    await expect(setUp({ options: { tools: ["demo_nothing_read"] } })).rejects.toThrow("Unknown tool")
  })

  test("registers nothing when no tool is selected", async () => {
    const { tools } = await setUp({ options: { toolsets: ["beta"], exclude_tools: [ADMIN_ID] } })
    expect(tools.size).toBe(0)
  })

  test("without a profile it knows the package's own toolsets", async () => {
    const fake = fakeContext({ options: { toolsets: "all" } })
    await createV2Setup([], { env: {} })(fake.ctx)
    expect(fake.tools.size).toBe(0)
    await expect(
      createV2Setup([], { env: {} })(fakeContext({ options: { toolsets: ["unknown-toolset"] } }).ctx),
    ).rejects.toThrow('Unknown toolset "unknown-toolset"')
  })
})

describe("V2 tool calls", () => {
  test("a read tool never asks, runs in the session's directory and returns content and output", async () => {
    const { tools, asserts, events } = await setUp({ location: { directory: "/work/project" } })
    const result = await tools.get(READ_ID)!.execute({ count: 2 }, { sessionID: SESSION_ID, signal })
    const output = { tool: READ_ID, cwd: "/work/project", count: 2 }
    expect(result).toEqual({ content: JSON.stringify(output), output })
    expect(asserts).toEqual([])
    expect(events).toEqual([`execute:${READ_ID}`])
  })

  test("a write tool asks with its id as the action and its target as the resource, before it runs", async () => {
    const { tools, asserts, events } = await setUp({ location: { directory: "/work/project" } })
    await tools.get(ADD_ID)!.execute({ area: "north", count: 1 }, { sessionID: SESSION_ID, signal })
    expect(events).toEqual([`assert:${ADD_ID}`, `execute:${ADD_ID}`])
    expect(asserts).toEqual([
      {
        action: ADD_ID,
        resources: ["north"],
        save: ["north"],
        metadata: {
          arguments: { area: "north", count: 1 },
          class: "add",
          message: `Title of ${ADD_ID} on north`,
        },
        sessionID: SESSION_ID,
      },
    ])
  })

  test("a described write tool adds marked facts and text without changing its permission targets", async () => {
    const { tools, asserts, events } = await setUp()
    await tools.get(LABEL_ID)!.execute({ area: "north" }, { sessionID: SESSION_ID, signal })
    expect(events).toEqual([`assert:${LABEL_ID}`, `execute:${LABEL_ID}`])
    expect(asserts).toEqual([
      {
        action: LABEL_ID,
        resources: ["north"],
        save: ["north"],
        metadata: {
          arguments: { area: "north" },
          class: "add",
          message: `Title of ${LABEL_ID} on north\nArea: north\n\nBody<U+202E>`,
        },
        sessionID: SESSION_ID,
      },
    ])
  })

  test("a describe that throws still asks with the one-line message", async () => {
    const fake = fakeContext()
    const specs = fixtureSpecs(fake.events)
    specs.find((spec) => spec.id === LABEL_ID)!.describe = () => {
      throw new Error("cannot describe")
    }
    await createV2Setup(specs, { env: {}, profile: PROFILE })(fake.ctx)
    await fake.tools.get(LABEL_ID)!.execute({ area: "north" }, { sessionID: SESSION_ID, signal })
    expect(fake.asserts).toEqual([
      {
        action: LABEL_ID,
        resources: ["north"],
        save: ["north"],
        metadata: { arguments: { area: "north" }, class: "add", message: `Title of ${LABEL_ID} on north` },
        sessionID: SESSION_ID,
      },
    ])
    expect(fake.events).toEqual([`assert:${LABEL_ID}`, `execute:${LABEL_ID}`])
  })

  test("the resource keeps the target's case, and administrative tools ask too", async () => {
    const { tools, asserts } = await setUp({ options: { toolsets: "all" }, location: { directory: "/work/project" } })
    await tools.get(ADMIN_ID)!.execute({ area: "North" }, { sessionID: SESSION_ID, signal })
    expect(
      asserts.map((request) => [request.action, request.resources, request.save, request.metadata?.class]),
    ).toEqual([[ADMIN_ID, ["North"], ["North"], "administrative"]])
  })

  test("without an area argument the resource is the session's directory", async () => {
    const { tools, asserts } = await setUp({ location: { directory: "/work/other" } })
    await tools.get(ADD_ID)!.execute({}, { sessionID: SESSION_ID, signal })
    expect(asserts.map((request) => request.resources)).toEqual([["/work/other"]])
  })

  test("a call that writes to two targets asks for both, sorted, and the message names them", async () => {
    const { tools, asserts } = await setUp()
    await tools.get(ADD_ID)!.execute({ area: "south", extra_area: "east" }, { sessionID: SESSION_ID, signal })
    expect(asserts.map((request) => [request.resources, request.save])).toEqual([
      [
        ["east", "south"],
        ["east", "south"],
      ],
    ])
    expect(asserts[0]!.metadata?.message).toBe(`Title of ${ADD_ID} on east, south`)
  })

  test("a target that cannot be told is asked for beside the others, and never saved", async () => {
    const { tools, asserts } = await setUp()
    await tools.get(ADD_ID)!.execute({ area: "north", extra_area: "" }, { sessionID: SESSION_ID, signal })
    expect(asserts.map((request) => [request.resources, request.save])).toEqual([[["north", "*"], ["north"]]])
  })

  test("the resource is * when the arguments are invalid, and an always answer saves nothing", async () => {
    const { tools, asserts } = await setUp()
    await expect(tools.get(ADD_ID)!.execute({ area: 5 }, { sessionID: SESSION_ID, signal })).rejects.toThrow(
      "invalid_argument",
    )
    expect(asserts.map((request) => [request.resources, request.save])).toEqual([[["*"], []]])
  })

  test("the install directory is handed to the tool, and a call that cannot name its target there asks for *", async () => {
    const own = tempDir(cleanups)
    const { tools, asserts } = await setUp({ ownDir: own, location: { directory: own } })
    const read = await tools.get(READ_ID)!.execute({}, { sessionID: SESSION_ID, signal })
    const add = await tools.get(ADD_ID)!.execute({}, { sessionID: SESSION_ID, signal })
    expect([read, add].map(({ output }) => (output as { own_dir?: string }).own_dir)).toEqual([own, own])
    expect(asserts.map((request) => request.resources)).toEqual([["*"]])
  })

  test("a denial stops the call and surfaces the harness's error", async () => {
    const denial = new Error(`Permission denied: ${ADD_ID}`)
    const { tools, events } = await setUp({ deny: denial })
    await expect(tools.get(ADD_ID)!.execute({}, { sessionID: SESSION_ID, signal })).rejects.toBe(denial)
    expect(events).toEqual([`assert:${ADD_ID}`])
  })

  test("a read tool falls back to the process directory when the session's directory cannot be read", async () => {
    const withoutLocation = await setUp({ location: {} })
    const missing = await setUp({ location: null })
    for (const { tools } of [withoutLocation, missing]) {
      const { output } = await tools.get(READ_ID)!.execute({}, { sessionID: SESSION_ID, signal })
      expect((output as { cwd: string }).cwd).toBe(process.cwd())
    }
  })

  test("a write tool fails closed when the session's directory cannot be read: no ask, no run", async () => {
    for (const location of [{}, null]) {
      const { tools, asserts, events } = await setUp({ location })
      await expect(tools.get(ADD_ID)!.execute({ area: "north" }, { sessionID: SESSION_ID, signal })).rejects.toThrow(
        /^invalid_argument: The session's directory could not be read.*retry\.$/,
      )
      expect(asserts).toEqual([])
      expect(events).toEqual([])
    }
  })

  test("a tool failure reaches the harness as an Error reading <code>: <message>", async () => {
    const { tools } = await setUp({ location: { directory: "/work/project" } })
    const failure = await tools
      .get(FAILING_ID)!
      .execute({}, { sessionID: SESSION_ID, signal })
      .catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("not_found: No such thing.")
  })

  test("invalid arguments fail with invalid_argument", async () => {
    const { tools } = await setUp({ location: { directory: "/work/project" } })
    await expect(tools.get(READ_ID)!.execute({ count: "x" }, { sessionID: SESSION_ID, signal })).rejects.toThrow(
      new RegExp(`^invalid_argument: Invalid arguments for ${READ_ID}`),
    )
  })
})

describe("V2 skills", () => {
  async function withSkillsDir(run: (dir: string) => Promise<void>) {
    const dir = await mkdtemp(join(tmpdir(), "skills-"))
    try {
      await run(dir)
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  }

  test("registers the skills of the injected directory", async () => {
    await withSkillsDir(async (dir) => {
      await mkdir(join(dir, "triage"))
      await writeFile(join(dir, "triage", "SKILL.md"), "---\nname: thing-triage\ndescription: Sort things\n---\nBody\n")
      const fake = fakeContext()
      await createV2Setup([], { skillsDir: dir, profile: PROFILE })(fake.ctx)
      expect(fake.skills).toEqual([
        {
          id: "thing-triage",
          name: "thing-triage",
          description: "Sort things",
          path: join(dir, "triage", "SKILL.md"),
          content: "Body\n",
        },
      ])
    })
  })

  test("registers no skill when the directory is missing", async () => {
    const fake = fakeContext()
    await createV2Setup([], { skillsDir: join(tmpdir(), "skills-no-such-dir"), profile: PROFILE })(fake.ctx)
    expect(fake.skills).toEqual([])
  })
})
