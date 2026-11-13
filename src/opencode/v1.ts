import { inputJsonSchema, type GrantContext, type ToolOptions, type ToolSpec, type Translator } from "../core"
import { DESCRIBE_TIMEOUT_MS } from "../entry/description"
import { ANY_RESOURCE } from "../entry/permission"
import { approvalOf } from "../entry/pin"
import {
  harnessError,
  needsPermission,
  permissionMetadata,
  personOnlyIds,
  runTool,
  savedResources,
  selectedTools,
  type PluginDeps,
} from "./shared"
import type { OpenCodePlugin, PluginOptions, V1Config, V1Hooks, V1Tool, V1ToolContext } from "./types"

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

function v1Tool(
  spec: ToolSpec,
  ownDir: string | undefined,
  t: Translator,
  options: ToolOptions,
  grants: GrantContext,
): V1Tool {
  return {
    description: `${spec.description}${describeArguments(spec)}`,
    args: spec.input.shape,
    async execute(args: unknown, context: V1ToolContext): Promise<string> {
      const ctx = { cwd: workingDir(context), ownDir, options, grants, signal: context.abort }
      let pin: string | undefined
      if (needsPermission(spec)) {
        const approval = await approvalOf(spec, args, ctx, DESCRIBE_TIMEOUT_MS, t)
        if (approval.refused) throw harnessError(approval.refused)
        const { resources, description } = approval
        pin = approval.pin
        await context.ask({
          permission: spec.id,
          patterns: resources,
          always: savedResources(spec, resources),
          metadata: permissionMetadata(spec, args, resources, description, t),
        })
      }
      const result = await runTool(spec, args, ctx, pin)
      return JSON.stringify(result)
    },
  }
}

/**
 * The permission rule of a person-only tool once it is forced to ask: `deny`
 * stays; a record of patterns keeps its `deny` entries over an `ask` for every
 * resource, so no `allow` of it stands; anything else becomes `ask`.
 */
function askingRule(configured: unknown): unknown {
  if (configured === "deny") return configured
  if (typeof configured !== "object" || configured === null || Array.isArray(configured)) return "ask"
  const denied = Object.entries(configured).filter(([, action]) => action === "deny")
  return Object.fromEntries([[ANY_RESOURCE, "ask"], ...denied])
}

/**
 * The `config` hook that makes each person-only tool's permission `ask`, since
 * the host allows an action no rule names. A configured `deny` stays. A
 * permission set as one action for every tool is left as it is: it has no
 * per-tool rule to change, and a global `allow` still lets the tool through.
 */
function askPersonOnlyConfig(ids: string[]): (config: V1Config) => Promise<void> {
  return async (config) => {
    if (typeof config.permission === "string") return
    const permission = config.permission ?? {}
    for (const id of ids) permission[id] = askingRule(permission[id])
    config.permission = permission
  }
}

/**
 * The `server` of the OpenCode V1 plugin: the tools the plugin options select,
 * each asking the harness's permission before a non-read call, and a `config`
 * hook that keeps a person-only tool asking whatever the rules say. V1 has no
 * skill registration. A settings mistake throws, so the harness reports the
 * plugin as failed.
 */
export function createV1Server(specs: ToolSpec[], deps: PluginDeps = {}): OpenCodePlugin["server"] {
  return async function server(_input: unknown, options?: PluginOptions): Promise<V1Hooks> {
    const tool: V1Hooks["tool"] = {}
    const selected = selectedTools(specs, options, deps)
    for (const spec of selected.specs) {
      tool[spec.id] = v1Tool(spec, deps.ownDir, selected.translator, selected.options, selected.grants)
    }
    const personOnly = personOnlyIds(selected.specs)
    return personOnly.length > 0 ? { tool, config: askPersonOnlyConfig(personOnly) } : { tool }
  }
}
