import { inputJsonSchema, type ToolSpec } from "../core"
import { permissionResources } from "../entry/permission"
import {
  needsPermission,
  permissionMetadata,
  persistableResources,
  runTool,
  selectedTools,
  type PluginDeps,
} from "./shared"
import type { OpenCodePlugin, PluginOptions, V1Hooks, V1Tool, V1ToolContext } from "./types"

type PropertySchema = {
  type?: unknown
  enum?: unknown[]
  items?: PropertySchema
  description?: string
}

/** The type a property is listed with: its enum values, `array of <item type>`, its JSON Schema type, or `any`. */
function typeName(property: PropertySchema): string {
  if (property.enum?.length) return property.enum.map(String).join(" | ")
  if (property.type === "array") return `array of ${property.items ? typeName(property.items) : "any"}`
  return typeof property.type === "string" ? property.type : "any"
}

/**
 * The tool's arguments as text for its description. V1 passes the argument
 * shape through the host's own Zod, which drops the descriptions of ours, so
 * the model reads them here instead.
 */
function describeArguments(spec: ToolSpec): string {
  const { properties = {}, required = [] } = inputJsonSchema(spec) as {
    properties?: Record<string, PropertySchema>
    required?: string[]
  }
  const lines = Object.entries(properties).map(([name, property]) => {
    const kind = required.includes(name) ? typeName(property) : `${typeName(property)}, optional`
    const text = property.description?.replace(/\s+/g, " ").trim()
    return `- ${name} (${kind})${text ? `: ${text}` : ""}`
  })
  return lines.length > 0 ? `\n\nArguments:\n${lines.join("\n")}` : ""
}

/** V1 reports `/` as the worktree of a project outside git, where the session's directory is the better answer. */
function workingDir(context: V1ToolContext): string {
  return context.worktree && context.worktree !== "/" ? context.worktree : context.directory
}

function v1Tool(spec: ToolSpec, ownDir: string | undefined): V1Tool {
  return {
    description: `${spec.description}${describeArguments(spec)}`,
    args: spec.input.shape,
    async execute(args: unknown, context: V1ToolContext): Promise<string> {
      const ctx = { cwd: workingDir(context), ownDir, signal: context.abort }
      if (needsPermission(spec)) {
        const resources = await permissionResources(spec, args, ctx)
        await context.ask({
          permission: spec.id,
          patterns: resources,
          always: persistableResources(resources),
          metadata: permissionMetadata(spec, args, resources),
        })
      }
      const result = await runTool(spec, args, ctx)
      return JSON.stringify(result)
    },
  }
}

/**
 * The `server` of the OpenCode V1 plugin: the tools the plugin options select,
 * each asking the harness's permission before a non-read call. V1 has no skill
 * registration. A settings mistake throws, so the harness reports the plugin
 * as failed.
 */
export function createV1Server(specs: ToolSpec[], deps: PluginDeps = {}): OpenCodePlugin["server"] {
  return async function server(_input: unknown, options?: PluginOptions): Promise<V1Hooks> {
    const tool: V1Hooks["tool"] = {}
    for (const spec of selectedTools(specs, options, deps.env, deps.profile)) tool[spec.id] = v1Tool(spec, deps.ownDir)
    return { tool }
  }
}
