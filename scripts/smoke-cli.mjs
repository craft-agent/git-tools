import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { spawnSync } from "node:child_process"
import { fileURLToPath } from "node:url"

const CLI = fileURLToPath(new URL("../dist/cli.js", import.meta.url))
const SERVER = fileURLToPath(new URL("../dist/mcp.js", import.meta.url))
const EXIT_FAILED = 1
const EXIT_USAGE = 2
const UNKNOWN_TOOL = "unknown_nonexistent_read"

function expect(condition, message) {
  if (!condition) throw new Error(message)
}

function cli(args, input = "") {
  return spawnSync(process.execPath, [CLI, ...args], { encoding: "utf8", input, stdio: "pipe" })
}

/** The tool names the MCP server lists with the given settings; it draws on the same registry as the CLI. */
async function mcpToolNames(args) {
  const client = new Client({ name: "smoke", version: "0.0.0" })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [SERVER, ...args] }))
  try {
    return (await client.listTools()).tools.map((tool) => tool.name)
  } finally {
    await client.close()
  }
}

async function listsTheServersTools() {
  for (const settings of [[], ["--toolsets", "all"], ["--toolsets", "all", "--read-only"]]) {
    const label = ["list", ...settings].join(" ")
    const run = cli(["list", ...settings])
    expect(run.status === 0, `Expected exit 0 for ${label}, got ${run.status}: ${run.stderr}`)
    const listed = JSON.parse(run.stdout)
    const expected = await mcpToolNames(settings)
    expect(
      JSON.stringify(listed.map((tool) => tool.id)) === JSON.stringify(expected),
      `Expected ${label} to give ${JSON.stringify(expected)}, got ${run.stdout}`,
    )
    for (const tool of listed) {
      expect(
        typeof tool.title === "string" && typeof tool.class === "string" && tool.input_schema?.type === "object",
        `Expected a described tool, got ${JSON.stringify(tool)}`,
      )
    }
    console.log(`${label} gives the ${listed.length} tools the MCP server lists.`)
  }
}

function rejectsAnUnknownTool() {
  const run = cli(["run", UNKNOWN_TOOL, "--cwd", process.cwd()], "{}")
  const code = JSON.parse(run.stdout).error?.code
  expect(
    run.status === EXIT_FAILED && code === "invalid_argument",
    `Expected exit ${EXIT_FAILED} and invalid_argument for ${UNKNOWN_TOOL}, got ${run.status}: ${run.stdout}`,
  )
  console.log(`run ${UNKNOWN_TOOL} exits ${EXIT_FAILED} with invalid_argument.`)
}

function rejectsConfirm() {
  const run = cli(["list", "--confirm", "x"])
  expect(run.status === EXIT_USAGE, `Expected exit ${EXIT_USAGE} for --confirm x, got ${run.status}: ${run.stderr}`)
  expect(run.stdout === "", `Expected nothing on stdout for --confirm x, got: ${run.stdout}`)
  console.log(`--confirm x exits ${EXIT_USAGE}: ${run.stderr.trim()}`)
}

try {
  await listsTheServersTools()
  rejectsAnUnknownTool()
  rejectsConfirm()
} catch (error) {
  console.error(error)
  process.exit(1)
}
