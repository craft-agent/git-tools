import { invoke, isToolError, selectTools, type ToolContext, type ToolSpec } from "../core"
import { ANY_RESOURCE } from "../entry/permission"
import { PROJECT_PROFILE, type EntryProfile } from "../entry/profile"
import { settingsFromOptions } from "../entry/settings"
import type { PluginOptions } from "./types"

/** What a plugin takes from its surroundings; each has a default, and a test supplies its own. */
export type PluginDeps = {
  /** Where the `<envPrefix>_*` settings fall back to; defaults to `process.env`. */
  env?: Record<string, string | undefined>
  /** The settings' environment prefix and the toolsets; defaults to this package's. */
  profile?: EntryProfile
  /** The directory holding `<name>/SKILL.md` files, for the harness version that registers skills. */
  skillsDir?: URL | string
  /** Where the plugin is installed: never a call's working tree. */
  ownDir?: string
}

/** The one plain line a person reads when the harness asks to run a tool; it names everything the call writes to. */
export function permissionMessage(spec: Pick<ToolSpec, "title">, resources: string[]): string {
  return resources.length === 1 && resources[0] === ANY_RESOURCE
    ? spec.title
    : `${spec.title} on ${resources.join(", ")}`
}

/** The resources an "always" answer may persist: all but `*`, which would grant every target. */
export function persistableResources(resources: string[]): string[] {
  return resources.filter((resource) => resource !== ANY_RESOURCE)
}

/** What the harness is told about a call it is asked to allow. */
export function permissionMetadata(spec: Pick<ToolSpec, "title" | "class">, args: unknown, resources: string[]) {
  return { arguments: args, class: spec.class, message: permissionMessage(spec, resources) }
}

/** Whether a call must be allowed by the harness first: every tool but a read tool. */
export function needsPermission(spec: Pick<ToolSpec, "class">): boolean {
  return spec.class !== "read"
}

/** The tools the plugin options (and the environment behind them) select from `specs`. */
export function selectedTools(
  specs: ToolSpec[],
  options: PluginOptions | undefined,
  env: Record<string, string | undefined> = process.env,
  profile: EntryProfile = PROJECT_PROFILE,
): ToolSpec[] {
  return selectTools(specs, settingsFromOptions(options, env, profile), profile.toolsets)
}

/** Runs a tool through core `invoke`; a tool failure reaches the harness as an `Error` reading `<code>: <message>`. */
export async function runTool(spec: ToolSpec, args: unknown, ctx: ToolContext): Promise<unknown> {
  try {
    return await invoke(spec, args, ctx)
  } catch (error) {
    if (!isToolError(error)) throw error
    throw new Error(`${error.code}: ${error.message}`, { cause: error })
  }
}
