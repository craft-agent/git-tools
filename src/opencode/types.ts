import type { z } from "zod"

/** The slices of the two OpenCode plugin APIs the entry point uses; neither package is imported at runtime. */

/** The options a plugin is configured with; V1 passes them to `server`, V2 as `ctx.options`. */
export type PluginOptions = Readonly<Record<string, unknown>>

/** Mirrors the V2 `permission.assert` input of `@opencode/plugin` (promise API). */
export type V2PermissionRequest = {
  sessionID: string
  action: string
  resources: string[]
  /** The resources an "always" answer persists. */
  save?: string[]
  metadata?: Record<string, unknown>
}

/** Mirrors the context a V2 tool's `execute` receives (`@opencode/plugin`, promise API). */
export type V2ToolContext = {
  sessionID: string
  signal: AbortSignal
}

/** Mirrors `Tool.Result` of `@opencode/plugin` V2: a text `content` for the model and a structured `output`. */
export type V2ToolResult = {
  content: string
  output: unknown
}

/** Mirrors the tool a V2 `ToolEditor.add` takes; `input` and `output` are Standard Schema objects. */
export type V2Tool = {
  name: string
  description: string
  input: z.ZodObject<any>
  output: z.ZodObject<any>
  execute(input: unknown, context: V2ToolContext): Promise<V2ToolResult>
}

/** Mirrors `Skill.Info` of `@opencode/plugin` V2. */
export type V2Skill = {
  id: string
  name: string
  description?: string
  path: string
  content: string
}

/** Mirrors the V2 `ctx.tool.transform` and `ctx.skill.transform` registration, reduced to `add`. */
export type V2Transform<Item> = (callback: (editor: { add(item: Item): void }) => void) => Promise<unknown>

/** Mirrors the context a V2 plugin's `setup` receives (`@opencode/plugin`, promise API). */
export type V2Context = {
  options?: PluginOptions
  session: {
    get(input: { sessionID: string }): Promise<{ location?: { directory?: string } }>
  }
  permission: {
    assert(input: V2PermissionRequest): Promise<void>
  }
  tool: { transform: V2Transform<V2Tool> }
  skill: { transform: V2Transform<V2Skill> }
}

/** Mirrors the `ask` input of the V1 tool context (`@opencode-ai/plugin`). */
export type V1AskRequest = {
  permission: string
  patterns: string[]
  always: string[]
  metadata: Record<string, unknown>
}

/** Mirrors the V1 tool context (`@opencode-ai/plugin`), reduced to what a call here reads. */
export type V1ToolContext = {
  directory: string
  worktree: string
  abort: AbortSignal
  ask(request: V1AskRequest): Promise<void>
}

/** Mirrors a V1 tool definition (`@opencode-ai/plugin`): a Zod shape for `args`, and a string result. */
export type V1Tool = {
  description: string
  args: Record<string, z.ZodType>
  execute(args: unknown, context: V1ToolContext): Promise<string>
}

/** Mirrors the hooks a V1 `server` returns (`@opencode-ai/plugin`), reduced to `tool`. */
export type V1Hooks = {
  tool: Record<string, V1Tool>
}

/** Mirrors V1's `PluginModule` (`@opencode-ai/plugin`) and the V2 plugin (`id`, `setup`) in one module. */
export type OpenCodePlugin = {
  id: string
  setup(context: V2Context): Promise<void>
  server(input: unknown, options?: PluginOptions): Promise<V1Hooks>
}
