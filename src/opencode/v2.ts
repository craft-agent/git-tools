import type { ToolSpec } from "../core"
import { permissionResources } from "../entry/permission"
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

function v2Tool(ctx: V2Context, spec: ToolSpec, ownDir: string | undefined): V2Tool {
  return {
    name: spec.id,
    description: spec.description,
    input: spec.input.strict(),
    output: spec.output,
    async execute(input: unknown, { sessionID, signal }: V2ToolContext): Promise<V2ToolResult> {
      const directory = await sessionDirectory(ctx, sessionID)
      if (needsPermission(spec)) {
        if (directory === undefined) {
          throw new Error(
            `invalid_argument: The session's directory could not be read, so ${spec.id} cannot tell what it changes; retry.`,
          )
        }
        const resources = await permissionResources(spec, input, { cwd: directory, ownDir, signal })
        await ctx.permission.assert({
          action: spec.id,
          resources,
          save: persistableResources(resources),
          metadata: permissionMetadata(spec, input, resources),
          sessionID,
        })
      }
      const result = await runTool(spec, input, { cwd: directory ?? process.cwd(), ownDir, signal })
      return { content: JSON.stringify(result), output: result }
    },
  }
}

/**
 * The `setup` of the OpenCode V2 plugin: registers the tools the plugin
 * options select, each asking the harness's permission before a non-read call,
 * and the package's skills. A settings mistake throws, so the harness reports
 * the plugin as failed.
 */
export function createV2Setup(specs: ToolSpec[], deps: PluginDeps = {}): OpenCodePlugin["setup"] {
  return async function setup(ctx: V2Context): Promise<void> {
    const tools = selectedTools(specs, ctx.options, deps.env, deps.profile).map((spec) =>
      v2Tool(ctx, spec, deps.ownDir),
    )
    const skills = deps.skillsDir === undefined ? [] : await loadSkills(deps.skillsDir)

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
