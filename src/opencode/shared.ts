import {
  ENGLISH,
  invoke,
  isToolError,
  selectTools,
  type ToolContext,
  type ToolError,
  type ToolOptions,
  type ToolSpec,
  type Translations,
  type Translator,
} from "../core"
import { DESCRIBE_TIMEOUT_MS, approvalPrompt, standIn, type ShownDescription } from "../entry/description"
import { errorText } from "../entry/errors"
import { ANY_RESOURCE } from "../entry/permission"
import { checkPin } from "../entry/pin"
import { PROJECT_PROFILE, type EntryProfile } from "../entry/profile"
import { settingsFromOptions } from "../entry/settings"
import { promptTranslator, promptWords } from "../entry/words"
import type { PluginOptions, V2OperationError } from "./types"

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
  /** The translations of the tools' words, per language, for the approval prompt; defaults to none, which keeps it in English. */
  translations?: Translations
  /** Finds OpenCode's force-required error class for a worktree removal; defaults to importing it from the harness's plugin package, `undefined` when that release does not export it. */
  worktreeOperationError?: () => Promise<V2OperationError | undefined>
}

/** The resources an "always" answer may persist: all but `*`, which would grant every target. */
export function persistableResources(resources: string[]): string[] {
  return resources.filter((resource) => resource !== ANY_RESOURCE)
}

/** What the harness is told about a call it is asked to allow. */
export function permissionMetadata(
  spec: Pick<ToolSpec, "title" | "intent" | "class">,
  args: unknown,
  resources: string[],
  description?: ShownDescription,
  t: Translator = ENGLISH,
) {
  return {
    arguments: args,
    class: spec.class,
    message: approvalPrompt(standIn(spec, t), resources, description, promptWords(t)),
  }
}

/** Whether a call must be allowed by the harness first: every tool but a read tool. */
export function needsPermission(spec: Pick<ToolSpec, "class">): boolean {
  return spec.class !== "read"
}

/**
 * The tools the plugin options (and the environment behind them) select from
 * `specs`, the translator of the prompt language they set over the plugin's
 * translations, and the values of the package's own settings they carry, for
 * the context of every call.
 */
export function selectedTools(
  specs: ToolSpec[],
  options: PluginOptions | undefined,
  deps: PluginDeps,
): { specs: ToolSpec[]; translator: Translator; options: ToolOptions } {
  const profile = deps.profile ?? PROJECT_PROFILE
  const settings = settingsFromOptions(options, deps.env ?? process.env, profile)
  return {
    specs: selectTools(specs, settings, profile.toolsets),
    translator: promptTranslator(deps.translations ?? {}, settings.language),
    options: settings.options,
  }
}

/** A tool error as the `Error` the harness is given: `<code>: <message>`, with `details` as JSON on a line of its own when set. */
export function harnessError(error: ToolError): Error {
  return new Error(errorText(error), { cause: error })
}

/**
 * Runs a tool through core `invoke`, after `checkPin` has found what its
 * approval showed unchanged (a `pin` of `undefined` checks nothing); a tool
 * failure, `stale` included, reaches the harness as an `Error` reading
 * `<code>: <message>`, with `details` as JSON on a line of its own when set.
 */
export async function runTool(spec: ToolSpec, args: unknown, ctx: ToolContext, pin?: string): Promise<unknown> {
  try {
    await checkPin(spec, args, ctx, pin, DESCRIBE_TIMEOUT_MS)
    return await invoke(spec, args, ctx)
  } catch (error) {
    if (!isToolError(error)) throw error
    throw harnessError(error)
  }
}
