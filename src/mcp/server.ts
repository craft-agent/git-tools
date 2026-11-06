import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js"
import {
  annotations,
  inputJsonSchema,
  invoke,
  isAbortError,
  isToolError,
  outputJsonSchema,
  selectTools,
  toolMeta,
  type ErrorCode,
  type ToolContext,
  type ToolSpec,
  type Toolsets,
} from "../core"
import { PROJECT_PROFILE } from "../entry/profile"
import type { EntrySettings } from "../entry/settings"
import { PROJECT } from "../project"
import { elicitationConfirm } from "./confirm"
import { createWorkingDirResolver } from "./roots"

const DEFAULT_VERSION = "0.0.0"

export type ServerOptions = {
  /** The directory a call runs in when the client names no usable root; defaults to `process.cwd`. */
  cwd?: () => string
  /** Where the tools are installed: never a call's working tree, so a client root inside it is skipped. */
  ownDir?: string
  /** The toolsets the settings select from; defaults to this package's. */
  toolsets?: Toolsets
  /** The version the server reports; defaults to `0.0.0`. */
  version?: string
  /** Receives the full text of an unexpected error, which the client never sees; defaults to stderr. */
  log?: (entry: string) => void
}

function errorResult(code: ErrorCode, message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: JSON.stringify({ error: { code, message } }) }] }
}

function describeTool(spec: ToolSpec): Tool {
  const meta = toolMeta(spec)
  return {
    name: spec.id,
    title: spec.title,
    description: spec.description,
    inputSchema: inputJsonSchema({ input: spec.input.strict() }) as Tool["inputSchema"],
    outputSchema: outputJsonSchema(spec) as Tool["outputSchema"],
    annotations: annotations(spec),
    ...(meta && { _meta: meta }),
  }
}

/**
 * An MCP server that serves the tools the settings select from `specs`, over
 * whatever transport is connected. Each call runs in the client's working
 * directory, and with `confirm: "elicitation"` an administrative tool asks
 * through a form where the client offers one.
 */
export function createServer(specs: ToolSpec[], settings: EntrySettings, options: ServerOptions = {}): Server {
  const log = options.log ?? ((entry: string) => process.stderr.write(`${entry}\n`))
  const server = new Server(
    { name: PROJECT.name, version: options.version ?? DEFAULT_VERSION },
    { capabilities: { tools: {} } },
  )
  const workingDir = createWorkingDirResolver(server, options.cwd ?? (() => process.cwd()), options.ownDir)
  const toolsets = options.toolsets ?? PROJECT_PROFILE.toolsets
  const selected = new Map(selectTools(specs, settings, toolsets).map((spec) => [spec.id, spec]))
  const tools = [...selected.values()].map(describeTool)

  server.setRequestHandler(ListToolsRequestSchema, () => ({ tools }))

  server.setRequestHandler(CallToolRequestSchema, async (request, extra): Promise<CallToolResult> => {
    const spec = selected.get(request.params.name)
    if (!spec) return errorResult("invalid_argument", `Unknown tool "${request.params.name}".`)
    try {
      const confirm = settings.confirm === "elicitation" ? elicitationConfirm(server, extra.signal) : undefined
      const ctx: ToolContext = {
        cwd: await workingDir(extra.signal),
        ownDir: options.ownDir,
        signal: extra.signal,
        ...(confirm && { confirm }),
      }
      const result = await invoke(spec, request.params.arguments ?? {}, ctx)
      return { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result }
    } catch (error) {
      if (isAbortError(error)) throw error
      if (isToolError(error)) return errorResult(error.code, error.message)
      log(
        `Unexpected error while running ${spec.id}: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`,
      )
      return errorResult("internal_error", `Unexpected error while running ${spec.id}; see the server log.`)
    }
  })

  return server
}
