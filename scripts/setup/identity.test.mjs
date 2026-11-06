import { describe, expect, test } from "bun:test"
import { createReplacer, deriveIdentity, isQuotedStringFile, toScreamingSnake, toSnake } from "./identity.mjs"

const STARTER_DESCRIPTION = "A starter for tool packages."
const OPTIONS = {
  prefix: "widget",
  description: 'Widget "tools" for agents.',
  name: "widget-tools",
  owner: "Acme",
  repo: "widget-tools",
  scope: "@acme",
  marketplace: "acme-market",
  author: "Acme",
}

const replace = createReplacer(deriveIdentity(OPTIONS, STARTER_DESCRIPTION))
const replaced = (text, quoted) => replace(text, quoted).text

describe("name forms", () => {
  test("snake and screaming snake case", () => {
    expect(toSnake("widget-tools")).toBe("widget_tools")
    expect(toScreamingSnake("widget-tools-2")).toBe("WIDGET_TOOLS_2")
    expect(toScreamingSnake("widget")).toBe("WIDGET")
  })
})

describe("the replacement table", () => {
  test.each([
    ["@craftsamo/agent-tool-starter@<version>", "@acme/widget-tools@<version>"],
    ["io.github.craftsamo/agent-tool-starter", "io.github.Acme/widget-tools"],
    ["https://github.com/craftsamo/agent-tool-starter#readme", "https://github.com/Acme/widget-tools#readme"],
    ["craftsamo-agent-tool-starter-1.0.0.tgz", "acme-widget-tools-1.0.0.tgz"],
    ["agent-tool-starter@craftsamo", "widget-tools@acme-market"],
    ["AGENT_TOOL_STARTER_READ_ONLY", "WIDGET_TOOLS_READ_ONLY"],
    ["mcp__agent_tool_starter__example_*", "mcp__widget_tools__widget_*"],
    ["agent-tool-starter-cli", "widget-tools-cli"],
    ["example-notes", "widget-notes"],
  ])("%j becomes %j", (text, expected) => {
    expect(replaced(text)).toBe(expected)
  })

  test("a scoped name is never turned into the new name under the old scope", () => {
    expect(replaced('"@craftsamo/agent-tool-starter"')).toBe('"@acme/widget-tools"')
    expect(replaced("npm i @craftsamo/agent-tool-starter")).not.toContain("craftsamo")
  })

  test("the repository's other craftsamo names stay", () => {
    const text = '"@craftsamo/repo-kit": "^1", uses: craftsamo/repo-kit/.github/workflows/x.yml@v1'
    expect(replaced(text)).toBe(text)
  })

  test("only a tool prefix at the start of a word is renamed", () => {
    expect(replaced("example_note_read, `example_*`, (example_x)")).toBe("widget_note_read, `widget_*`, (widget_x)")
    expect(replaced("exampleNoteRead for example, example.com, example_ and src/core/example/")).toBe(
      "exampleNoteRead for example, example.com, example_ and src/core/example/",
    )
    expect(replaced("myexample_tool Example_Tool")).toBe("myexample_tool Example_Tool")
  })

  test("the description is written raw, and escaped inside a JSON or YAML string", () => {
    const text = `"description": "${STARTER_DESCRIPTION}"`
    expect(replaced(STARTER_DESCRIPTION, false)).toBe('Widget "tools" for agents.')
    expect(JSON.parse(`{${replaced(text, true)}}`).description).toBe('Widget "tools" for agents.')
  })

  test("a replacement text is never replaced again, and `$` in it stays", () => {
    const tricky = createReplacer(deriveIdentity({ ...OPTIONS, description: "Costs $& and agent-tool-starter" }, "D"))
    expect(tricky("D").text).toBe("Costs $& and agent-tool-starter")
  })

  test("counts the replacements", () => {
    expect(replace("agent-tool-starter agent_tool_starter and nothing else").count).toBe(2)
    expect(replace("nothing here").count).toBe(0)
  })
})

describe("isQuotedStringFile", () => {
  test("JSON and YAML files only", () => {
    expect(["a.json", ".mcp.json", "plugin.yaml", "x.yml"].map(isQuotedStringFile)).toEqual([true, true, true, true])
    expect(["README.md", "src/x.ts", "LICENSE"].map(isQuotedStringFile)).toEqual([false, false, false])
  })
})
