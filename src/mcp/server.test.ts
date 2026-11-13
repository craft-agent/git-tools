import { afterEach, describe, expect, test } from "bun:test"
import { REQUIRES_USER_INTERACTION, annotations, selectTools } from "../core"
import { PROJECT_PROFILE } from "../entry/profile"
import type { EntrySettings } from "../entry/settings"
import { PACKAGE_TOOLS } from "../entry/tools"
import { createServer } from "./server"
import { TOOLSETS, connect, runCleanups, settings, tool, type Call } from "./testing"

afterEach(runCleanups)

describe("tool list", () => {
  const calls: Call[] = []
  const specs = [
    tool("demo_thing_read", "alpha", "read", calls),
    tool("demo_thing_create", "alpha", "add", calls),
    tool("demo_thing_label", "alpha", "idempotent", calls),
    tool("demo_thing_edit", "alpha", "overwrite", calls),
    tool("demo_other_read", "beta", "read", calls),
    tool("demo_other_delete", "beta", "administrative", calls),
  ]
  const names = async (entry: EntrySettings) => {
    const { client } = await connect(specs, entry)
    return (await client.listTools()).tools.map((t) => t.name)
  }

  test("follows selectTools: the default toolsets", async () => {
    expect(await names(settings())).toEqual(selectTools(specs, {}, TOOLSETS).map((s) => s.id))
    expect(await names(settings())).toEqual([
      "demo_thing_read",
      "demo_thing_create",
      "demo_thing_label",
      "demo_thing_edit",
    ])
  })

  test("follows selectTools: toolsets, read_only, tools and exclude_tools", async () => {
    for (const given of [
      { toolsets: "all" as const },
      { toolsets: "all" as const, read_only: true },
      { tools: ["demo_other_delete"] },
      { exclude_tools: ["demo_thing_edit"] },
      { toolsets: ["beta"], exclude_tools: ["demo_other_read"] },
    ]) {
      expect(await names(settings(given))).toEqual(selectTools(specs, given, TOOLSETS).map((s) => s.id))
    }
  })

  test("a server with no tool selected lists none", async () => {
    expect(
      await names(settings({ toolsets: ["beta"], exclude_tools: ["demo_other_read", "demo_other_delete"] })),
    ).toEqual([])
  })

  test("an unknown tool id in the settings fails createServer", () => {
    expect(() => createServer(specs, settings({ tools: ["demo_nope_read"] }), { toolsets: TOOLSETS })).toThrow(
      /demo_nope_read/,
    )
  })

  test("an unknown toolset in the settings fails createServer, naming the toolsets there are", () => {
    expect(() => createServer(specs, settings({ toolsets: ["gamma"] }), { toolsets: TOOLSETS })).toThrow(
      /"gamma".*alpha, beta/,
    )
  })

  test("a server built without toolsets knows the package's own", () => {
    expect(() => createServer([], settings({ toolsets: "all" }))).not.toThrow()
    expect(() => createServer([], settings({ toolsets: ["unknown-toolset"] }))).toThrow(/unknown-toolset/)
  })

  test("publishes the title, description, annotations and meta of each class", async () => {
    const { client } = await connect(specs, settings({ toolsets: "all" }))
    const { tools } = await client.listTools()
    for (const spec of specs) {
      const listed = tools.find((t) => t.name === spec.id)!
      expect(listed.title).toBe(spec.title)
      expect(listed.description).toBe(spec.description)
      expect(listed.annotations).toEqual(annotations(spec))
      expect(listed._meta).toEqual(spec.class === "administrative" ? { [REQUIRES_USER_INTERACTION]: true } : undefined)
    }
  })

  test("publishes an object output schema and an input schema that forbids extra properties", async () => {
    const { client } = await connect(specs, settings())
    for (const listed of (await client.listTools()).tools) {
      expect(listed.outputSchema?.type).toBe("object")
      expect(listed.outputSchema?.required).toEqual(["tool"])
      expect(listed.inputSchema.type).toBe("object")
      expect(listed.inputSchema.additionalProperties).toBe(false)
    }
  })
})

describe("the class of a tool", () => {
  const calls: Call[] = []

  test("a read tool stays under read_only, with read-only hints and no meta", async () => {
    for (const given of [{}, { read_only: true }]) {
      const { client } = await connect([tool("demo_thing_read", "alpha", "read", calls)], settings(given))
      const [listed] = (await client.listTools()).tools
      expect(listed!.annotations).toEqual({
        title: listed!.title!,
        readOnlyHint: true,
        idempotentHint: true,
        openWorldHint: true,
      })
      expect(listed!._meta).toBeUndefined()
    }
  })

  test.each([
    ["add", { destructiveHint: false, idempotentHint: false }],
    ["idempotent", { destructiveHint: false, idempotentHint: true }],
    ["overwrite", { destructiveHint: true, idempotentHint: true }],
  ] as const)("a %s tool is a write tool, and read_only leaves it out", async (writeClass, hints) => {
    const specs = [tool("demo_thing_write", "alpha", writeClass, calls)]
    const [listed] = (await (await connect(specs, settings())).client.listTools()).tools
    expect(listed!.annotations).toEqual({ title: listed!.title!, readOnlyHint: false, ...hints, openWorldHint: true })
    expect(listed!._meta).toBeUndefined()

    const { client: readOnly } = await connect(specs, settings({ read_only: true }))
    expect((await readOnly.listTools()).tools).toEqual([])
  })
})

describe("the package's tools", () => {
  test("each is published with its class's annotations, an object output and a strict input", async () => {
    const { client } = await connect(
      PACKAGE_TOOLS,
      settings({ toolsets: "all" }),
      {},
      { toolsets: PROJECT_PROFILE.toolsets },
    )
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name)).toEqual(PACKAGE_TOOLS.map((spec) => spec.id))
    for (const spec of PACKAGE_TOOLS) {
      const listed = tools.find((t) => t.name === spec.id)!
      expect(listed.annotations).toEqual(annotations(spec))
      expect(listed.outputSchema?.type).toBe("object")
      expect(listed.inputSchema.additionalProperties).toBe(false)
    }
  })
})
