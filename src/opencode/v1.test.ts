import { tool as hostTool } from "@opencode-ai/plugin"
import { afterEach, describe, expect, test } from "bun:test"
import { z } from "zod"
import { defineTool } from "../core"
import { ALL_TOOLS } from "../tools"
import { ADD_ID, ADMIN_ID, FAILING_ID, LABEL_ID, PROFILE, READ_ID, fixtureSpecs, tempDir } from "./testing"
import type { V1AskRequest, V1ToolContext } from "./types"
import { createV1Server } from "./v1"

const cleanups: (() => void)[] = []

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

type Fake = {
  options?: Record<string, unknown>
  env?: Record<string, string | undefined>
  ownDir?: string
  deny?: Error
}

async function setUp(fake: Fake = {}) {
  const events: string[] = []
  const asks: V1AskRequest[] = []
  const context: V1ToolContext = {
    directory: "/work/project/sub",
    worktree: "/work/project",
    abort: new AbortController().signal,
    async ask(request) {
      asks.push(request)
      events.push(`ask:${request.permission}`)
      if (fake.deny) throw fake.deny
    },
  }
  const { tool } = await createV1Server(fixtureSpecs(events), {
    env: fake.env ?? {},
    profile: PROFILE,
    ownDir: fake.ownDir,
  })({}, fake.options)
  return { tool, asks, events, context }
}

describe("V1 server", () => {
  test("registers the default toolsets with the spec's description and argument shape", async () => {
    const { tool } = await setUp()
    expect(Object.keys(tool)).toEqual([READ_ID, ADD_ID, LABEL_ID, FAILING_ID])
    expect(tool[READ_ID]!.description).toBe(
      `Description of ${READ_ID}\n\nArguments:\n- area (string, optional): The area the call works in.\n- count (integer, optional): How many.`,
    )
    expect(Object.keys(tool[READ_ID]!.args)).toEqual(["area", "count"])
    expect(z.object(tool[READ_ID]!.args).parse({ count: 1 })).toEqual({ count: 1 })
  })

  test("takes toolsets, read_only and tools from the options", async () => {
    expect(Object.keys((await setUp({ options: { toolsets: "all" } })).tool)).toContain(ADMIN_ID)
    expect(Object.keys((await setUp({ options: { read_only: true } })).tool)).toEqual([READ_ID])
    expect(Object.keys((await setUp({ options: { exclude_tools: [ADD_ID] } })).tool)).toEqual([
      READ_ID,
      LABEL_ID,
      FAILING_ID,
    ])
    expect(Object.keys((await setUp({ env: { DEMO_TOOLSETS: "beta" } })).tool)).toEqual([ADMIN_ID])
  })

  // Validation crosses, JSON Schema only partly: `.describe()` writes to the registry of the Zod copy that made the
  // schema and the host's Zod 4.1.8 keeps its own, so its JSON Schema has the fields but not our descriptions, and
  // `.int()` reads as `number` there (the check still rejects 2.5).
  test("the argument shape works in the host's own Zod: it parses, rejects and lists its fields", async () => {
    const { tool } = await setUp()
    const host = hostTool.schema
    const args = host.object(tool[READ_ID]!.args)
    expect(args.parse({ area: "north", count: 2 })).toEqual({ area: "north", count: 2 })
    expect(args.safeParse({ count: "2" }).success).toBe(false)
    expect(args.safeParse({ area: 5 }).success).toBe(false)
    expect(args.safeParse({ count: 2.5 }).success).toBe(false)

    const schema = host.toJSONSchema(args) as {
      properties: Record<string, { type: string; description?: string }>
    }
    expect(schema.properties.area).toMatchObject({ type: "string" })
    expect(schema.properties.count).toMatchObject({ type: "number" })
  })

  test("rejects an unknown toolset and a wrong option type", async () => {
    await expect(setUp({ options: { toolsets: ["bogus"] } })).rejects.toThrow('Unknown toolset "bogus"')
    await expect(setUp({ options: { read_only: "yes" } })).rejects.toThrow('Option "read_only"')
  })

  test("without a profile it knows the package's own toolsets and variables", async () => {
    const { tool } = await createV1Server([], { env: {} })({}, { toolsets: "all" })
    expect(tool).toEqual({})
    await expect(createV1Server([], { env: {} })({}, { toolsets: ["unknown-toolset"] })).rejects.toThrow(
      'Unknown toolset "unknown-toolset"',
    )
  })
})

describe("V1 tool descriptions", () => {
  const spec = (id: string, input: z.ZodObject<any>) =>
    defineTool({
      id,
      title: id,
      description: "Does a thing.",
      toolset: "alpha",
      class: "read",
      input,
      output: z.object({}),
      async execute() {
        return {}
      },
    })
  const deps = { env: {}, profile: PROFILE }

  test("lists each argument with its type, optionality and description, in schema order", async () => {
    const { tool } = await createV1Server(
      [
        spec(
          "demo_thing_read",
          z.object({
            thing: z.string().describe("The thing,\n  as a number or URL."),
            state: z.enum(["open", "closed"]).describe("Which things.").optional(),
            limit: z.number().int().describe("How many.").optional(),
            labels: z.array(z.string()).describe("Labels to match.").optional(),
            ids: z.array(z.number().int()).optional(),
            extra: z.object({ a: z.string() }).optional(),
            anything: z.unknown().optional(),
          }),
        ),
      ],
      deps,
    )({}, {})
    expect(tool.demo_thing_read!.description).toBe(
      [
        "Does a thing.",
        "",
        "Arguments:",
        "- thing (string): The thing, as a number or URL.",
        "- state (open | closed, optional): Which things.",
        "- limit (integer, optional): How many.",
        "- labels (array of string, optional): Labels to match.",
        "- ids (array of integer, optional)",
        "- extra (object, optional)",
        "- anything (any, optional)",
      ].join("\n"),
    )
  })

  test("adds no section to a tool without arguments", async () => {
    const { tool } = await createV1Server([spec("demo_thing_read", z.object({}))], deps)({}, {})
    expect(tool.demo_thing_read!.description).toBe("Does a thing.")
  })
})

describe("V1 tool calls", () => {
  test("a read tool never asks, runs in the worktree and returns a JSON string", async () => {
    const { tool, asks, events, context } = await setUp()
    const result = await tool[READ_ID]!.execute({ count: 2 }, context)
    expect(result).toBe(JSON.stringify({ tool: READ_ID, cwd: "/work/project", count: 2 }))
    expect(asks).toEqual([])
    expect(events).toEqual([`execute:${READ_ID}`])
  })

  test("runs in the directory when there is no worktree", async () => {
    const { tool, context } = await setUp()
    const result = await tool[READ_ID]!.execute({}, { ...context, worktree: "" })
    expect(JSON.parse(result)).toEqual({ tool: READ_ID, cwd: "/work/project/sub" })
  })

  test("runs in the directory when the project is outside git and the worktree is /", async () => {
    const { tool, context } = await setUp()
    const result = await tool[READ_ID]!.execute({}, { ...context, worktree: "/" })
    expect(JSON.parse(result)).toEqual({ tool: READ_ID, cwd: "/work/project/sub" })
  })

  test("a write tool asks with its id as the permission and its target as the pattern, before it runs", async () => {
    const { tool, asks, events, context } = await setUp()
    await tool[ADD_ID]!.execute({ area: "north" }, context)
    expect(events).toEqual([`ask:${ADD_ID}`, `execute:${ADD_ID}`])
    expect(asks).toEqual([
      {
        permission: ADD_ID,
        patterns: ["north"],
        always: ["north"],
        metadata: { arguments: { area: "north" }, class: "add", message: `Title of ${ADD_ID} on north` },
      },
    ])
  })

  test("a described write tool adds marked facts and text without changing its permission targets", async () => {
    const { tool, asks, events, context } = await setUp()
    await tool[LABEL_ID]!.execute({ area: "north" }, context)
    expect(events).toEqual([`ask:${LABEL_ID}`, `execute:${LABEL_ID}`])
    expect(asks).toEqual([
      {
        permission: LABEL_ID,
        patterns: ["north"],
        always: ["north"],
        metadata: {
          arguments: { area: "north" },
          class: "add",
          message: `Title of ${LABEL_ID} on north\nArea: north\n\nBody<U+202E>`,
        },
      },
    ])
  })

  test("the pattern keeps the target's case, and administrative tools ask too", async () => {
    const { tool, asks, context } = await setUp({ options: { toolsets: "all" } })
    await tool[ADMIN_ID]!.execute({ area: "North" }, context)
    expect(asks.map((request) => [request.permission, request.patterns, request.always])).toEqual([
      [ADMIN_ID, ["North"], ["North"]],
    ])
  })

  test("without an area argument the pattern is the working directory", async () => {
    const { tool, asks, context } = await setUp()
    await tool[ADD_ID]!.execute({}, context)
    await tool[ADD_ID]!.execute({}, { ...context, worktree: "/work/other" })
    expect(asks.map((request) => request.patterns)).toEqual([["/work/project"], ["/work/other"]])
  })

  test("a call that writes to two targets asks for both, sorted, and the message names them", async () => {
    const { tool, asks, context } = await setUp()
    await tool[ADD_ID]!.execute({ area: "south", extra_area: "east" }, context)
    expect(asks.map((request) => [request.patterns, request.always])).toEqual([
      [
        ["east", "south"],
        ["east", "south"],
      ],
    ])
    expect(asks[0]!.metadata.message).toBe(`Title of ${ADD_ID} on east, south`)
  })

  test("a target that cannot be told is asked for as * beside the others, and never saved", async () => {
    const { tool, asks, context } = await setUp()
    await tool[ADD_ID]!.execute({ area: "north", extra_area: "" }, context)
    expect(asks.map((request) => [request.patterns, request.always])).toEqual([[["north", "*"], ["north"]]])
  })

  test("the pattern is * when the arguments are invalid, and an always answer saves nothing", async () => {
    const { tool, asks, context } = await setUp()
    await expect(tool[ADD_ID]!.execute({ area: 5 }, context)).rejects.toThrow("invalid_argument")
    expect(asks.map((request) => [request.patterns, request.always])).toEqual([[["*"], []]])
  })

  test("the install directory is handed to the tool, and a call that cannot name its target there asks for *", async () => {
    const own = tempDir(cleanups)
    const { tool, asks, context } = await setUp({ ownDir: own })
    const inInstallDir = { ...context, worktree: own }
    expect(JSON.parse(await tool[READ_ID]!.execute({}, inInstallDir)).own_dir).toBe(own)
    expect(JSON.parse(await tool[ADD_ID]!.execute({}, inInstallDir)).own_dir).toBe(own)
    await tool[ADD_ID]!.execute({ area: "north" }, inInstallDir)
    expect(asks.map((request) => request.patterns)).toEqual([["*"], ["north"]])
  })

  test("a denial stops the call and surfaces the harness's error", async () => {
    const denial = new Error("The user rejected this call.")
    const { tool, events, context } = await setUp({ deny: denial })
    await expect(tool[ADD_ID]!.execute({}, context)).rejects.toBe(denial)
    expect(events).toEqual([`ask:${ADD_ID}`])
  })

  test("a tool failure reaches the harness as an Error reading <code>: <message>", async () => {
    const { tool, context } = await setUp()
    const failure = await tool[FAILING_ID]!.execute({}, context).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toBe("not_found: No such thing.")
  })

  test("re-validates the arguments strictly", async () => {
    const { tool, context } = await setUp()
    await expect(tool[READ_ID]!.execute({ extra: 1 }, context)).rejects.toThrow(
      `invalid_argument: Invalid arguments for ${READ_ID}: extra: unknown argument`,
    )
  })
})

describe("V1 permission for the package's own tools", () => {
  const STOP = new Error("stopped at the question")

  test("every tool but a read tool asks the harness before it runs", async () => {
    const context: V1ToolContext = {
      directory: "/work/project",
      worktree: "/work/project",
      abort: new AbortController().signal,
      async ask() {
        throw STOP
      },
    }
    const { tool } = await createV1Server(ALL_TOOLS, { env: {} })({}, { toolsets: "all" })
    for (const spec of ALL_TOOLS.filter((candidate) => candidate.class !== "read")) {
      await expect(tool[spec.id]!.execute({}, context)).rejects.toBe(STOP)
    }
  })
})
