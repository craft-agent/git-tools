import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { isToolError } from "../core"
import { packageRoot } from "../entry/package-root"
import { parseSettings } from "../entry/settings"
import { PROJECT } from "../project"
import { ALL_TOOLS } from "../tools"
import { createServer } from "./server"

/** The exit code of a command line the settings reject. */
const EXIT_USAGE = 2

async function main(): Promise<void> {
  let server: ReturnType<typeof createServer>
  try {
    const settings = parseSettings(process.argv.slice(2), process.env)
    server = createServer(ALL_TOOLS, settings, {
      ownDir: packageRoot(import.meta.url),
      version: typeof __VERSION__ === "string" ? __VERSION__ : undefined,
    })
  } catch (error) {
    if (!isToolError(error)) throw error
    process.stderr.write(`${PROJECT.name}: ${error.message}\n`)
    process.exitCode = EXIT_USAGE
    return
  }
  await server.connect(new StdioServerTransport())
}

main().catch((error: unknown) => {
  process.stderr.write(`${PROJECT.name}: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
