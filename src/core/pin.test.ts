import { describe, expect, test } from "bun:test"
import { PIN_PATTERN, pinOf } from "./pin"
import type { CallDescription } from "./tool"

const BASE: CallDescription = {
  headline: { text: "Write {name}", values: { name: "todo" } },
  facts: [
    { label: "Kind", value: "note" },
    { label: "Size", value: { text: "{bytes} bytes", values: { bytes: 42 } } },
  ],
  text: { label: "Note text", body: "# Todo" },
  pins: { hash: "abc" },
}
const RESOURCES = ["/work/todo.md"]

describe("pinOf", () => {
  test("is the lowercase hex of a SHA-256", () => {
    expect(pinOf(RESOURCES, BASE)).toMatch(PIN_PATTERN)
  })

  test("is the same for the same input, whatever order its keys come in", () => {
    const reordered: CallDescription = {
      pins: { hash: "abc" },
      text: { body: "# Todo", label: "Note text" },
      facts: [
        { value: "note", label: "Kind" },
        { value: { values: { bytes: 42 }, text: "{bytes} bytes" }, label: "Size" },
      ],
      headline: { values: { name: "todo" }, text: "Write {name}" },
    }
    expect(pinOf(RESOURCES, reordered)).toBe(pinOf(RESOURCES, BASE))
  })

  test("changes with the order of the facts and of the resources", () => {
    expect(pinOf(RESOURCES, { ...BASE, facts: [...BASE.facts].reverse() })).not.toBe(pinOf(RESOURCES, BASE))
    expect(pinOf(["a", "b"], BASE)).not.toBe(pinOf(["b", "a"], BASE))
  })

  test.each<[string, string[], CallDescription]>([
    ["a resource", ["/work/other.md"], BASE],
    ["an added resource", [...RESOURCES, "/work/more.md"], BASE],
    ["the headline text", RESOURCES, { ...BASE, headline: { ...BASE.headline!, text: "Overwrite {name}" } }],
    ["a headline value", RESOURCES, { ...BASE, headline: { ...BASE.headline!, values: { name: "other" } } }],
    ["no headline", RESOURCES, { ...BASE, headline: undefined }],
    ["a fact label", RESOURCES, { ...BASE, facts: [{ label: "Type", value: "note" }, BASE.facts[1]!] }],
    ["a fact string value", RESOURCES, { ...BASE, facts: [{ label: "Kind", value: "dir" }, BASE.facts[1]!] }],
    [
      "a fact template",
      RESOURCES,
      { ...BASE, facts: [BASE.facts[0]!, { label: "Size", value: { text: "{bytes} B", values: { bytes: 42 } } }] },
    ],
    [
      "a fact template value",
      RESOURCES,
      { ...BASE, facts: [BASE.facts[0]!, { label: "Size", value: { text: "{bytes} bytes", values: { bytes: 43 } } }] },
    ],
    ["the text label", RESOURCES, { ...BASE, text: { label: "Body", body: "# Todo" } }],
    ["the text body", RESOURCES, { ...BASE, text: { label: "Note text", body: "# Todo!" } }],
    ["no text", RESOURCES, { ...BASE, text: undefined }],
    ["a pin value", RESOURCES, { ...BASE, pins: { hash: "abd" } }],
    ["a pin name", RESOURCES, { ...BASE, pins: { digest: "abc" } }],
    ["an added pin", RESOURCES, { ...BASE, pins: { hash: "abc", mtime: "1" } }],
    ["no pins", RESOURCES, { ...BASE, pins: undefined }],
  ])("changes with %s", (_name, resources, description) => {
    expect(pinOf(resources, description)).not.toBe(pinOf(RESOURCES, BASE))
  })

  test("takes a value that holds a quote, a backslash or a surrogate pair as it is", () => {
    const tricky = (value: string): CallDescription => ({ facts: [{ label: "A", value }] })
    const values = ['a"b', "a\\b", "a😀b", "a\u0000b", ""]
    expect(new Set(values.map((value) => pinOf([], tricky(value)))).size).toBe(values.length)
  })
})
