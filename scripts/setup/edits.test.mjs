import { describe, expect, test } from "bun:test"
import { SetupError } from "./errors.mjs"
import { editForExample } from "./example.mjs"
import { editPackageJson } from "./package-json.mjs"
import { editSpots } from "./spots.mjs"
import { resetVersion } from "./version.mjs"

const OPTIONS = {
  prefix: "widget",
  owner: "acme",
  author: 'A "B"',
  authorUrl: "https://example.test/author",
  publisher: "Acme Inc",
  marketplace: "acme-market",
  keepExample: false,
}

describe("editSpots", () => {
  test("renames author and author-url in plugin manifests", () => {
    const manifest = `{\n  "author": {\n    "name": "craftsamo",\n    "url": "https://github.com/craftsamo"\n  },\n  "dep": "@craftsamo/repo-kit"\n}\n`
    const { text, count } = editSpots("plugin.json", manifest, OPTIONS)
    expect(count).toBe(1)
    expect(JSON.parse(text)).toEqual({
      author: { name: 'A "B"', url: "https://example.test/author" },
      dep: "@craftsamo/repo-kit",
    })
  })

  test("renames owner object, description and marketplace in claude marketplace", () => {
    const marketplace = `{\n  "name": "craftsamo",\n  "description": "Plugins by craftsamo.",\n  "owner": {\n    "name": "craftsamo",\n    "url": "https://github.com/craftsamo"\n  }\n}\n`
    const { text, count } = editSpots(".claude-plugin/marketplace.json", marketplace, OPTIONS)
    expect(count).toBe(3)
    expect(JSON.parse(text)).toEqual({
      name: "acme-market",
      description: "Plugins by Acme Inc.",
      owner: { name: "Acme Inc", url: "https://github.com/acme" },
    })
  })

  test("renames the marketplace name and sets displayName to publisher in agents marketplace", () => {
    const marketplace = `{\n  "name": "craftsamo",\n  "interface": {\n    "displayName": "craftsamo"\n  },\n  "plugins": [{ "name": "x" }]\n}\n`
    const { text } = editSpots(".agents/plugins/marketplace.json", marketplace, OPTIONS)
    expect(JSON.parse(text).name).toBe("acme-market")
    expect(JSON.parse(text).interface.displayName).toBe("Acme Inc")
  })

  test("writes the license holder raw", () => {
    expect(editSpots("LICENSE", "Copyright (c) 2026 CraftSamo\n", OPTIONS).text).toBe('Copyright (c) 2026 A "B"\n')
  })

  test("leaves other files alone and refuses a file that lost its spot", () => {
    expect(editSpots("README.md", "craftsamo", OPTIONS)).toEqual({ text: "craftsamo", count: 0 })
    expect(() => editSpots("LICENSE", "Copyright (c) 2026 Someone\n", OPTIONS)).toThrow(SetupError)
  })
})

describe("editPackageJson", () => {
  const source = `{\n  "name": "x",\n  "private": true,\n  "scripts": {\n    "test": "t",\n    "setup": "node scripts/setup/main.mjs",\n    "build": "b"\n  }\n}\n`

  test("drops `private` and the setup script and keeps the formatting", () => {
    const { text, count } = editPackageJson(source)
    expect(text).toBe(`{\n  "name": "x",\n  "scripts": {\n    "test": "t",\n    "build": "b"\n  }\n}\n`)
    expect(count).toBe(2)
  })

  test("refuses a setup script it cannot take out by line", () => {
    expect(() => editPackageJson(source.replace('"build": "b"', '"setup": "node scripts/setup/main.mjs"'))).toThrow(
      SetupError,
    )
  })
})

describe("resetVersion", () => {
  test("starts package.json and the manifests at 0.0.0, keeping nested versions", () => {
    const json = `{\n  "name": "x",\n  "version": "0.1.0",\n  "engines": { "version": "9" }\n}\n`
    expect(resetVersion("package.json", json)).toEqual({
      text: `{\n  "name": "x",\n  "version": "0.0.0",\n  "engines": { "version": "9" }\n}\n`,
      count: 1,
    })
    expect(resetVersion("plugin.yaml", "name: x\nversion: 0.1.0\n")).toEqual({
      text: "name: x\nversion: 0.0.0\n",
      count: 1,
    })
    expect(resetVersion(".claude-plugin/plugin.json", `{\n  "version": "0.0.0"\n}\n`).count).toBe(0)
  })

  test("leaves other files alone and refuses a manifest without a version", () => {
    expect(resetVersion("mcp.json", `{\n  "version": "1"\n}\n`).count).toBe(0)
    expect(() => resetVersion("plugin.json", "{}\n")).toThrow(SetupError)
  })
})

describe("editForExample", () => {
  const project = `  toolPrefix: "example",\n  toolsets: ["notes"] as readonly string[],\n  defaultToolsets: ["notes"] as readonly string[],\n`

  test("sets the prefix and empties the toolsets", () => {
    expect(editForExample("src/project.ts", project, OPTIONS).text).toBe(
      `  toolPrefix: "widget",\n  toolsets: [] as readonly string[],\n  defaultToolsets: [] as readonly string[],\n`,
    )
  })

  test("with keepExample sets the prefix only", () => {
    const { text } = editForExample("src/project.ts", project, { ...OPTIONS, keepExample: true })
    expect(text).toContain('toolsets: ["notes"]')
    expect(text).toContain('toolPrefix: "widget"')
  })

  test("sets the Hermes skill prefix wherever the package is named", () => {
    const python = 'SKILL_PREFIX = "example-"\n'
    expect(editForExample("src/hermes/widget_hermes/project.py", python, OPTIONS).text).toBe(
      'SKILL_PREFIX = "widget-"\n',
    )
  })

  test("empties the tool list of plugin.yaml and of src/tools.ts", () => {
    const yaml = "name: x\nprovides_tools:\n  - a_b\n  - a_c\nprovides_hooks:\n  - h\n"
    expect(editForExample("plugin.yaml", yaml, OPTIONS).text).toBe(
      "name: x\nprovides_tools: []\nprovides_hooks:\n  - h\n",
    )
    expect(editForExample("src/tools.ts", 'import { a } from "./core/example/a"\n', OPTIONS).text).toContain(
      "ALL_TOOLS: ToolSpec[] = []\n",
    )
  })

  test("refuses a tools file or a project file that is not the starter's", () => {
    expect(() => editForExample("src/tools.ts", "export const ALL_TOOLS = []\n", OPTIONS)).toThrow(SetupError)
    expect(() => editForExample("src/project.ts", 'toolPrefix: "git"\n', OPTIONS)).toThrow(SetupError)
  })
})
