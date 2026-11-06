import { z } from "zod"
import { ToolError, isAbortError, isToolError } from "./errors"

/** The toolsets of a package: every name, in the order `all` lists them, and the ones on when a setting names none. */
export type Toolsets = { names: readonly string[]; defaults: readonly string[] }

/** How far a tool's effect reaches; `docs/conventions.md` defines each class and its annotations. */
export type WriteClass = "read" | "add" | "idempotent" | "overwrite" | "administrative"

export type ConfirmRequest = { tool: string; message: string }

export type ToolContext = {
  /** The working directory the call runs in. */
  cwd: string
  /** A directory that is never the caller's working tree (where these tools are installed); a tool must refuse to treat it as the caller's tree. */
  ownDir?: string
  signal?: AbortSignal
  /** Asks the person to approve; absent when the harness's own approval already covers the call. */
  confirm?(request: ConfirmRequest): Promise<boolean>
}

export type ToolSpec<I extends z.ZodObject<any> = z.ZodObject<any>, O extends z.ZodObject<any> = z.ZodObject<any>> = {
  /** `<prefix>_<domain>_<verb>`; a public interface, so it never changes once published. */
  id: string
  title: string
  description: string
  toolset: string
  class: WriteClass
  /** What the call writes to, as the permission rules of an entry point name it. */
  targets?(args: z.output<I>, ctx: ToolContext): string[] | Promise<string[]>
  input: I
  output: O
  execute(args: z.output<I>, ctx: ToolContext): Promise<z.input<O>>
}

/** A client meta key that makes the client ask even under an allow rule. */
export const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction"

const TOOL_ID_PATTERN = /^[a-z]+(?:_[a-z]+){2,}$/
const MAX_TOOL_ID_LENGTH = 40
const READ_TOOL_SUFFIX = "_read"

/**
 * Returns the spec after checking what a type cannot: the ID's shape and
 * length, that a read tool is named `_read`, and that the output schema is an
 * object (a tool returns its data as a plain object). The ID's prefix is the
 * package's to check.
 */
export function defineTool<I extends z.ZodObject<any>, O extends z.ZodObject<any>>(
  spec: ToolSpec<I, O>,
): ToolSpec<I, O> {
  if (!TOOL_ID_PATTERN.test(spec.id)) {
    throw new Error(`Tool id "${spec.id}" must look like <prefix>_<domain>_<verb> in lowercase letters.`)
  }
  if (spec.id.length > MAX_TOOL_ID_LENGTH) {
    throw new Error(`Tool id "${spec.id}" is longer than ${MAX_TOOL_ID_LENGTH} characters.`)
  }
  if (spec.class === "read" && !spec.id.endsWith(READ_TOOL_SUFFIX)) {
    throw new Error(`Tool "${spec.id}" is a read tool, so its id must end in ${READ_TOOL_SUFFIX}.`)
  }
  if (!(spec.output instanceof z.ZodObject)) {
    throw new Error(`Tool "${spec.id}" must have an object output schema, since a result is an object.`)
  }
  return spec
}

export type ToolAnnotations = {
  title: string
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint: boolean
  openWorldHint: true
}

const CLASS_HINTS = {
  read: { readOnlyHint: true, idempotentHint: true },
  add: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  idempotent: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  overwrite: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  administrative: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
} as const satisfies Record<WriteClass, Omit<ToolAnnotations, "title" | "openWorldHint">>

/** The MCP annotations of a tool's write class. */
export function annotations(spec: Pick<ToolSpec, "title" | "class">): ToolAnnotations {
  return { title: spec.title, ...CLASS_HINTS[spec.class], openWorldHint: true }
}

/** The `_meta` an entry point publishes with the tool; only administrative tools carry any. */
export function toolMeta(spec: Pick<ToolSpec, "class">): Record<string, unknown> | undefined {
  return spec.class === "administrative" ? { [REQUIRES_USER_INTERACTION]: true } : undefined
}

/**
 * Asks the person before an administrative tool acts. Other classes never ask,
 * and a missing `ctx.confirm` means the harness's approval already covered the
 * call. Anything but an accept throws `declined`.
 */
export async function confirmWrite(
  spec: Pick<ToolSpec, "id" | "class">,
  ctx: Pick<ToolContext, "confirm">,
  message: string,
): Promise<void> {
  if (spec.class !== "administrative" || !ctx.confirm) return
  if ((await ctx.confirm({ tool: spec.id, message })) !== true) {
    throw new ToolError("declined", `${spec.id} was declined: ${message}`)
  }
}

/** The settings every entry point takes. */
export type ToolSettings = {
  /** The toolsets that are on; `"all"` turns on every one. Absent or empty means the default toolsets. */
  toolsets?: string[] | "all"
  /** Registers no write tool, and wins over every other setting. */
  read_only?: boolean
  /** Single tools to add, by id, whatever their toolset. */
  tools?: string[]
  /** Single tools to remove, by id; wins over `tools` and `toolsets`. */
  exclude_tools?: string[]
}

function knownIds(setting: string, ids: string[], known: ReadonlySet<string>): void {
  const unknown = ids.find((id) => !known.has(id))
  if (unknown !== undefined) throw new ToolError("invalid_argument", `Unknown tool "${unknown}" in ${setting}.`)
}

/** The tools the settings turn on, in the order of `all`. */
export function selectTools<S extends Pick<ToolSpec, "id" | "toolset" | "class">>(
  all: S[],
  settings: ToolSettings,
  toolsets: Toolsets,
): S[] {
  const ids = new Set<string>()
  for (const spec of all) {
    if (ids.has(spec.id)) throw new Error(`Duplicate tool id "${spec.id}".`)
    ids.add(spec.id)
  }

  const requested = settings.toolsets?.length === 0 ? undefined : settings.toolsets
  const on: ReadonlySet<string> = new Set(requested === "all" ? toolsets.names : (requested ?? toolsets.defaults))
  const unknownToolset = [...on].find((name) => !toolsets.names.includes(name))
  if (unknownToolset !== undefined) {
    const known =
      toolsets.names.length > 0 ? `use one of ${toolsets.names.join(", ")} or "all"` : "no toolsets are defined"
    throw new ToolError("invalid_argument", `Unknown toolset "${unknownToolset}"; ${known}.`)
  }
  const added = settings.tools ?? []
  const excluded = new Set(settings.exclude_tools ?? [])
  knownIds("tools", added, ids)
  knownIds("exclude_tools", [...excluded], ids)

  return all.filter(
    (spec) =>
      (on.has(spec.toolset) || added.includes(spec.id)) &&
      !excluded.has(spec.id) &&
      !(settings.read_only && spec.class !== "read"),
  )
}

function describeIssues(error: z.ZodError): string {
  return error.issues
    .flatMap((issue) => {
      const path = issue.path.map(String)
      if (issue.code === "unrecognized_keys") {
        return issue.keys.map((key) => `${[...path, key].join(".")}: unknown argument`)
      }
      return path.length ? `${path.join(".")}: ${issue.message}` : issue.message
    })
    .join("; ")
}

const MAX_RESULT_JSON_LENGTH = 2000

function describeResult(result: unknown): string {
  let json: string
  try {
    json = JSON.stringify(result) ?? String(result)
  } catch {
    json = String(result)
  }
  return json.length > MAX_RESULT_JSON_LENGTH ? `${json.slice(0, MAX_RESULT_JSON_LENGTH)}…` : json
}

/**
 * Runs a tool the way every entry point does: validates the raw arguments
 * as strict (`invalid_argument` on a bad or unknown one), executes, and
 * validates the result against the output schema. A result that does not
 * match is a bug in the tool; it throws `internal_error` carrying the raw
 * result, so whatever the call already created stays visible. Errors from
 * `execute` pass through unchanged.
 */
export async function invoke<I extends z.ZodObject<any>, O extends z.ZodObject<any>>(
  spec: ToolSpec<I, O>,
  rawArgs: unknown,
  ctx: ToolContext,
): Promise<z.output<O>> {
  const args = spec.input.strict().safeParse(rawArgs)
  if (!args.success) {
    throw new ToolError("invalid_argument", `Invalid arguments for ${spec.id}: ${describeIssues(args.error)}`, {
      cause: args.error,
    })
  }
  const result = await spec.execute(args.data as z.output<I>, ctx)
  const output = spec.output.safeParse(result)
  if (!output.success) {
    throw new ToolError(
      "internal_error",
      `${spec.id} returned a result that does not match its output schema (${describeIssues(output.error)}). The call may have gone through; its result was: ${describeResult(result)}`,
      { cause: output.error },
    )
  }
  return output.data
}

export function inputJsonSchema(spec: Pick<ToolSpec, "input">): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(spec.input, { io: "input" })
}

export function outputJsonSchema(spec: Pick<ToolSpec, "output">): z.core.JSONSchema.BaseSchema {
  return z.toJSONSchema(spec.output)
}

/**
 * Collects the failures of steps that run after a tool has already created
 * something, so those steps never throw and the creation is not lost: the
 * result lists them under `errors`, keyed by step. A cancellation is never
 * recorded; it is rethrown.
 */
export class StepErrors {
  readonly #errors: Record<string, string> = {}

  /** Runs one step; a failure is recorded under `step` and the step yields `undefined`. */
  async record<T>(step: string, fn: () => Promise<T>): Promise<T | undefined> {
    try {
      return await fn()
    } catch (error) {
      if (isAbortError(error)) throw error
      this.#errors[step] = isToolError(error)
        ? `${error.code}: ${error.message}`
        : error instanceof Error
          ? error.message
          : String(error)
      return undefined
    }
  }

  get errors(): Record<string, string> {
    return { ...this.#errors }
  }

  get any(): boolean {
    return Object.keys(this.#errors).length > 0
  }
}
