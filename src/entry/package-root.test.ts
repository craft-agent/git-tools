import { describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { pathToFileURL } from "node:url"
import { packageRoot } from "./package-root"

describe("packageRoot", () => {
  test("is the directory above the one holding the bundle, for a URL or its text", () => {
    const bundle = pathToFileURL("/opt/tools/node_modules/agent/dist/cli.js")
    expect(packageRoot(bundle)).toBe("/opt/tools/node_modules/agent")
    expect(packageRoot(bundle.href)).toBe("/opt/tools/node_modules/agent")
  })

  test("is the directory holding package.json for a bundle in this package's dist", () => {
    const root = packageRoot(new URL("../../dist/mcp.js", import.meta.url))
    expect(existsSync(join(root, "package.json"))).toBe(true)
  })

  test("reads a percent-encoded path back", () => {
    expect(packageRoot(pathToFileURL("/with space/pkg/dist/opencode.js"))).toBe("/with space/pkg")
  })
})
