import type { ToolOptions, ToolSpec, Translator } from "../core"
import { DESCRIBE_TIMEOUT_MS } from "../entry/description"
import { approvalOf } from "../entry/pin"
import { loadSkills } from "./skills"
import {
  needsPermission,
  permissionMetadata,
  persistableResources,
  runTool,
  selectedTools,
  type PluginDeps,
} from "./shared"
import type { OpenCodePlugin, V2Context, V2Tool, V2ToolContext, V2ToolResult } from "./types"

/** The directory of a session, or `undefined` when the harness cannot name it. */
async function sessionDirectory(ctx: V2Context, sessionID: string): Promise<string | undefined> {
  try {
    return (await ctx.session.get({ sessionID })).location?.directory || undefined
  } catch {
    return undefined
  }
}

function v2Tool(
  ctx: V2Context,
  spec: ToolSpec,
  ownDir: string | undefined,
  t: Translator,
  options: ToolOptions,
): V2Tool {
  return {
    name: spec.id,
    description: spec.description,
    input: spec.input.strict(),
    output: spec.output,
    async execute(input: unknown, { sessionID, signal }: V2ToolContext): Promise<V2ToolResult> {
      const directory = await sessionDirectory(ctx, sessionID)
      let pin: string | undefined
      if (needsPermission(spec)) {
        if (directory === undefined) {
          throw new Error(
            `invalid_argument: The session's directory could not be read, so ${spec.id} cannot tell what it changes; retry.`,
          )
        }
        const toolContext = { cwd: directory, ownDir, options, signal }
        const approval = await approvalOf(spec, input, toolContext, DESCRIBE_TIMEOUT_MS, t)
        const { resources, description } = approval
        pin = approval.pin
        await ctx.permission.assert({
          action: spec.id,
          resources,
          save: persistableResources(resources),
          metadata: permissionMetadata(spec, input, resources, description, t),
          sessionID,
        })
      }
      const result = await runTool(spec, input, { cwd: directory ?? process.cwd(), ownDir, options, signal }, pin)
      return { content: JSON.stringify(result), output: result }
    },
  }
}

/**
 * The `setup` of the OpenCode V2 plugin: registers the tools the plugin
 * options select, each asking the harness's permission before a non-read call,
 * and the package's skills, those linked to a toolset only when the options
 * leave that toolset a selected tool. A settings mistake throws, so the
 * harness reports the plugin as failed.
 */
export function createV2Setup(specs: ToolSpec[], deps: PluginDeps = {}): OpenCodePlugin["setup"] {
  return async function setup(ctx: V2Context): Promise<void> {
    const selected = selectedTools(specs, ctx.options, deps)
    const tools = selected.specs.map((spec) => v2Tool(ctx, spec, deps.ownDir, selected.translator, selected.options))
    const skills =
      deps.skillsDir === undefined
        ? []
        : await loadSkills(deps.skillsDir, new Set(selected.specs.map((spec) => spec.toolset)))

    if (tools.length > 0) {
      await ctx.tool.transform((editor) => {
        for (const tool of tools) editor.add(tool)
      })
    }
    if (skills.length > 0) {
      await ctx.skill.transform((editor) => {
        for (const skill of skills) editor.add(skill)
      })
    }
  }
}
