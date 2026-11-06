import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { isToolError } from "./errors"
import { defineTool, selectTools, type ToolSettings, type ToolSpec, type Toolsets, type WriteClass } from "./tool"

function spec(id: string, toolset: string, writeClass: WriteClass): ToolSpec {
  return defineTool({
    id,
    title: id,
    description: "A test tool.",
    toolset,
    class: writeClass,
    input: z.object({}),
    output: z.object({}),
    execute: async () => ({}),
  })
}

function caught(run: () => unknown): Error {
  try {
    run()
  } catch (error) {
    return error as Error
  }
  throw new Error("expected the call to throw")
}

describe("selectTools", () => {
  const toolsets: Toolsets = { names: ["alpha", "beta", "gamma"], defaults: ["alpha", "beta"] }
  const all = [
    spec("demo_thing_read", "alpha", "read"),
    spec("demo_thing_create", "alpha", "add"),
    spec("demo_other_read", "beta", "read"),
    spec("demo_other_merge", "beta", "administrative"),
    spec("demo_third_read", "gamma", "read"),
    spec("demo_third_add", "gamma", "add"),
  ]
  const ids = (settings: ToolSettings = {}) => selectTools(all, settings, toolsets).map((s) => s.id)

  test("defaults to the toolsets it is given", () => {
    expect(ids()).toEqual(["demo_thing_read", "demo_thing_create", "demo_other_read", "demo_other_merge"])
    expect(selectTools(all, {}, { names: toolsets.names, defaults: ["gamma"] }).map((s) => s.id)).toEqual([
      "demo_third_read",
      "demo_third_add",
    ])
  })

  test('"all" turns on every toolset it names', () => {
    expect(ids({ toolsets: "all" })).toEqual(all.map((s) => s.id))
    expect(selectTools(all, { toolsets: "all" }, { names: ["alpha"], defaults: [] }).map((s) => s.id)).toEqual([
      "demo_thing_read",
      "demo_thing_create",
    ])
  })

  test("an explicit list replaces the default", () => {
    expect(ids({ toolsets: ["gamma"] })).toEqual(["demo_third_read", "demo_third_add"])
  })

  test("an empty toolsets list means the default toolsets, like an absent one", () => {
    expect(ids({ toolsets: [] })).toEqual(ids())
    expect(ids({ toolsets: [] })).toEqual(ids({ toolsets: undefined }))
    expect(ids({ toolsets: [], tools: ["demo_third_add"] })).toContain("demo_third_add")
    expect(ids({ toolsets: [], read_only: true })).toEqual(["demo_thing_read", "demo_other_read"])
  })

  test("tools adds single tools across toolsets", () => {
    expect(ids({ tools: ["demo_third_add"] })).toContain("demo_third_add")
    expect(ids({ toolsets: ["gamma"], tools: ["demo_thing_create"] })).toEqual([
      "demo_thing_create",
      "demo_third_read",
      "demo_third_add",
    ])
  })

  test("exclude_tools removes, and wins over tools and toolsets", () => {
    expect(ids({ exclude_tools: ["demo_other_merge"] })).not.toContain("demo_other_merge")
    expect(ids({ tools: ["demo_third_add"], exclude_tools: ["demo_third_add"] })).not.toContain("demo_third_add")
  })

  test("read_only drops every non-read tool and wins over tools", () => {
    expect(ids({ read_only: true })).toEqual(["demo_thing_read", "demo_other_read"])
    expect(ids({ toolsets: ["alpha"], read_only: true, tools: ["demo_third_add", "demo_third_read"] })).toEqual([
      "demo_thing_read",
      "demo_third_read",
    ])
  })

  test("keeps the order of the full list", () => {
    expect(ids({ toolsets: ["beta", "alpha"] })).toEqual(ids())
  })

  test("an unknown toolset is invalid_argument naming it and the toolsets there are", () => {
    const error = caught(() => selectTools(all, { toolsets: ["alpha", "nope"] }, toolsets))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect(error.message).toContain("nope")
    for (const name of toolsets.names) expect(error.message).toContain(name)
  })

  test("with no toolsets defined, any named toolset is unknown and the message says so", () => {
    const none: Toolsets = { names: [], defaults: [] }
    const error = caught(() => selectTools([], { toolsets: ["nope"] }, none))
    expect(isToolError(error) && error.code).toBe("invalid_argument")
    expect(error.message).toContain('"nope"')
    expect(error.message).toContain("no toolsets are defined")
    expect(selectTools([], {}, none)).toEqual([])
    expect(selectTools([], { toolsets: "all" }, none)).toEqual([])
  })

  test("an unknown tool id in tools or exclude_tools is invalid_argument naming it", () => {
    for (const settings of [{ tools: ["demo_nope_read"] }, { exclude_tools: ["demo_nope_read"] }]) {
      const error = caught(() => selectTools(all, settings, toolsets))
      expect(isToolError(error) && error.code).toBe("invalid_argument")
      expect(error.message).toContain("demo_nope_read")
    }
  })

  test("duplicate ids are a plain Error", () => {
    const error = caught(() => selectTools([all[0]!, all[0]!], {}, toolsets))
    expect(isToolError(error)).toBe(false)
    expect(error.message).toContain("demo_thing_read")
  })
})
