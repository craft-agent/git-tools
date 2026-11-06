import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { isToolError } from "./errors"
import {
  REQUIRES_USER_INTERACTION,
  annotations,
  defineTool,
  inputJsonSchema,
  outputJsonSchema,
  toolMeta,
  type WriteClass,
} from "./tool"

const input = z.object({ count: z.number().int(), label: z.string().optional() })
const output = z.object({ total: z.number() })

describe("defineTool", () => {
  const base = {
    title: "T",
    description: "d",
    toolset: "alpha",
    class: "add",
    input,
    output,
    execute: async () => ({ total: 1 }),
  } as const

  test("returns the spec it was given", () => {
    const given = { ...base, id: "demo_thing_create" }
    expect(defineTool(given)).toBe(given)
  })

  test.each(["demo_thing_create", "demo_thing_item_add", "demo_thing_read", "a_b_c"])("accepts %s", (id) => {
    expect(() => defineTool({ ...base, id })).not.toThrow()
  })

  test.each([
    "thing_create",
    "demo_thing",
    "demo",
    "demo_Thing_create",
    "demo_thing_create2",
    "demo__thing_create",
    "demo_thing-create",
    "_demo_thing_create",
    "demo_thing_create_",
  ])("rejects the id %s", (id) => {
    expect(() => defineTool({ ...base, id })).toThrow(/<prefix>_<domain>_<verb>/)
  })

  test("rejects an id over 40 characters", () => {
    const id = `demo_${"a".repeat(20)}_${"b".repeat(15)}`
    expect(id.length).toBe(41)
    expect(() => defineTool({ ...base, id })).toThrow(/40/)
    expect(() => defineTool({ ...base, id: id.slice(0, 40) })).not.toThrow()
  })

  test("a read tool's id must end in _read", () => {
    expect(() => defineTool({ ...base, id: "demo_thing_list", class: "read" })).toThrow(/_read/)
    expect(() => defineTool({ ...base, id: "demo_thing_read", class: "read" })).not.toThrow()
  })

  test("rejects an output schema that is not an object", () => {
    const given = { ...base, id: "demo_thing_create", output: z.array(z.string()) }
    expect(() => defineTool(given as unknown as Parameters<typeof defineTool>[0])).toThrow(/object output schema/)
  })

  test("takes a targets resolver that reads the parsed arguments and the context", async () => {
    const given = defineTool({
      ...base,
      id: "demo_thing_create",
      targets: (args, ctx) => [`${ctx.cwd}:${args.count}`],
    })
    expect(await given.targets?.({ count: 2 }, { cwd: "/work" })).toEqual(["/work:2"])
  })

  test("throws a plain Error, not a ToolError", () => {
    try {
      defineTool({ ...base, id: "nope" })
    } catch (error) {
      expect(isToolError(error)).toBe(false)
      expect(error).toBeInstanceOf(Error)
    }
  })
})

describe("annotations", () => {
  const tool = (writeClass: WriteClass) => ({ title: "Title", class: writeClass })

  test("read", () => {
    expect(annotations(tool("read"))).toEqual({
      title: "Title",
      readOnlyHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
    expect("destructiveHint" in annotations(tool("read"))).toBe(false)
  })

  test("add", () => {
    expect(annotations(tool("add"))).toEqual({
      title: "Title",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: true,
    })
  })

  test("idempotent", () => {
    expect(annotations(tool("idempotent"))).toEqual({
      title: "Title",
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("overwrite", () => {
    expect(annotations(tool("overwrite"))).toEqual({
      title: "Title",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: true,
      openWorldHint: true,
    })
  })

  test("administrative", () => {
    expect(annotations(tool("administrative"))).toEqual({
      title: "Title",
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    })
  })
})

describe("toolMeta", () => {
  test("only administrative tools require user interaction", () => {
    expect(toolMeta({ class: "administrative" })).toEqual({ "anthropic/requiresUserInteraction": true })
    expect(REQUIRES_USER_INTERACTION).toBe("anthropic/requiresUserInteraction")
    for (const writeClass of ["read", "add", "idempotent", "overwrite"] as const) {
      expect(toolMeta({ class: writeClass })).toBeUndefined()
    }
  })
})

describe("JSON schemas", () => {
  const tool = defineTool({
    id: "demo_thing_count",
    title: "Count",
    description: "d",
    toolset: "alpha",
    class: "add",
    input: z.object({ count: z.number().int(), label: z.string().default("x") }),
    output,
    execute: async () => ({ total: 1 }),
  })

  test("input schema describes the arguments a caller sends", () => {
    const schema = inputJsonSchema(tool)
    expect(schema.type).toBe("object")
    expect(Object.keys(schema.properties ?? {})).toEqual(["count", "label"])
    expect(schema.required).toEqual(["count"])
  })

  test("output schema describes the result", () => {
    const schema = outputJsonSchema(tool)
    expect(schema.type).toBe("object")
    expect(schema.required).toEqual(["total"])
  })
})
