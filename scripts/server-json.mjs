import { readFileSync, writeFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

/**
 * Writes the MCP Registry's `server.json` from package.json, so the version it
 * names is never stale. The release workflow runs it right before
 * `mcp-publisher publish`; the file is not committed. Takes an optional output
 * path and writes `server.json` in the repository root otherwise.
 */

const PACKAGE = new URL("../package.json", import.meta.url)
const DEFAULT_OUTPUT = new URL("../server.json", import.meta.url)
const SCHEMA = "https://static.modelcontextprotocol.io/schemas/2025-12-11/server.schema.json"

/** The registry accepts at most this many characters in a description. */
export const DESCRIPTION_LIMIT = 100

/** The `server.json` document for a parsed package.json. */
export function serverJson(pkg) {
  if (!pkg.mcpName) throw new Error("package.json has no `mcpName` for the MCP Registry.")
  if (!pkg.description || pkg.description.length > DESCRIPTION_LIMIT) {
    throw new Error(
      `package.json needs a \`description\` of at most ${DESCRIPTION_LIMIT} characters for the MCP Registry.`,
    )
  }
  return {
    $schema: SCHEMA,
    name: pkg.mcpName,
    description: pkg.description,
    repository: { url: pkg.repository.url.replace(/^git\+/, "").replace(/\.git$/, ""), source: "github" },
    version: pkg.version,
    packages: [{ registryType: "npm", identifier: pkg.name, version: pkg.version, transport: { type: "stdio" } }],
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    const pkg = JSON.parse(readFileSync(PACKAGE, "utf8"))
    const output = process.argv[2] ?? DEFAULT_OUTPUT
    writeFileSync(output, `${JSON.stringify(serverJson(pkg), null, 2)}\n`)
    console.log(`Wrote ${output instanceof URL ? fileURLToPath(output) : output} for ${pkg.mcpName} ${pkg.version}.`)
  } catch (error) {
    console.error(error instanceof Error ? error.message : error)
    process.exit(1)
  }
}
