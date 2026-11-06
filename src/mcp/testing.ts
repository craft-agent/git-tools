import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import {
  ElicitRequestSchema,
  ListRootsRequestSchema,
  type CallToolResult,
  type ClientCapabilities,
  type ElicitResult,
} from "@modelcontextprotocol/sdk/types.js"
import { pathToFileURL } from "node:url"
import { z } from "zod"
import { confirmWrite, defineTool, type ToolContext, type ToolSpec, type Toolsets, type WriteClass } from "../core"
import type { EntrySettings } from "../entry/settings"
import { createServer, type ServerOptions } from "./server"

/** Fixtures the MCP server tests share. */

/** The toolsets the test servers are built with; `alpha` is the one on by default. */
export const TOOLSETS: Toolsets = { names: ["alpha", "beta"], defaults: ["alpha"] }

export type Call = { tool: string; args: unknown; ctx: ToolContext }

export const toolInput = z.object({ count: z.number().int().optional() })
export const toolOutput = z.object({ tool: z.string(), count: z.number().optional() })

/** A spec that records every call it executes; an administrative one asks first, as a real one does. */
export function tool(id: string, toolset: string, writeClass: WriteClass, calls: Call[]): ToolSpec {
  const self: ToolSpec = defineTool({
    id,
    title: `Title of ${id}`,
    description: `Description of ${id}`,
    toolset,
    class: writeClass,
    input: toolInput,
    output: toolOutput,
    async execute(args, ctx) {
      await confirmWrite(self, ctx, "Delete the thing")
      calls.push({ tool: id, args, ctx })
      return { tool: id, count: args.count }
    },
  })
  return self
}

export function failing(id: string, error: Error): ToolSpec {
  return defineTool({
    id,
    title: id,
    description: id,
    toolset: "alpha",
    class: "read",
    input: toolInput,
    output: toolOutput,
    async execute() {
      throw error
    },
  })
}

export const settings = (overrides: Partial<EntrySettings> = {}): EntrySettings => ({
  confirm: "harness",
  ...overrides,
})

/** What a test leaves to be torn down; each test file runs `runCleanups` in its own `afterEach`. */
export const cleanups: (() => void | Promise<void>)[] = []

export async function runCleanups(): Promise<void> {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
}

export type ClientSetup = {
  capabilities?: ClientCapabilities
  /** What the client answers to an elicitation. */
  answer?: ElicitResult
  /** Makes the client's elicitation handler throw instead of answering. */
  failElicitation?: boolean
  /** The roots the client lists, as paths or URIs; read on every request, so a test can change them. */
  roots?: { dirs: string[] }
}

const URI_SCHEME = /^[a-z][a-z0-9+.-]*:/i

/** Connects a client with the given capabilities to a new server, over an in-memory transport. */
export async function connect(
  specs: ToolSpec[],
  entry: EntrySettings,
  client: ClientSetup = {},
  options?: ServerOptions,
) {
  const elicited: unknown[] = []
  const logs: string[] = []
  const seen = { rootsRequests: 0 }
  const mcpClient = new Client({ name: "test", version: "0.0.0" }, { capabilities: client.capabilities ?? {} })
  if (client.capabilities?.elicitation) {
    mcpClient.setRequestHandler(ElicitRequestSchema, async (request) => {
      elicited.push(request.params)
      if (client.failElicitation) throw new Error("The form could not be shown.")
      return client.answer ?? { action: "decline" }
    })
  }
  if (client.capabilities?.roots) {
    mcpClient.setRequestHandler(ListRootsRequestSchema, async () => {
      seen.rootsRequests++
      return {
        roots: (client.roots?.dirs ?? []).map((dir) => ({ uri: URI_SCHEME.test(dir) ? dir : pathToFileURL(dir).href })),
      }
    })
  }
  const server = createServer(specs, entry, { log: (entry) => logs.push(entry), toolsets: TOOLSETS, ...options })
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair()
  await server.connect(serverSide)
  await mcpClient.connect(clientSide)
  cleanups.push(() => mcpClient.close())
  await mcpClient.listTools()
  return { client: mcpClient, elicited, logs, seen }
}

/** Gives a notification the client just sent time to reach the server. */
export const settle = () => new Promise((resolve) => setTimeout(resolve, 20))

export function textOf(result: CallToolResult): string {
  const [block] = result.content
  if (block?.type !== "text") throw new Error("expected a text block")
  return block.text
}

export async function call(client: Client, name: string, args: Record<string, unknown> = {}) {
  return (await client.callTool({ name, arguments: args })) as CallToolResult
}
