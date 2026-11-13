import { z } from "zod"
import { ToolError, isAbortError, isToolError } from "./errors"

/** The toolsets of a package: every name, in the order `all` lists them, and the ones on when a setting names none. */
export type Toolsets = { names: readonly string[]; defaults: readonly string[] }

/** How far a tool's effect reaches; `docs/conventions.md` defines each class and its annotations. */
export type WriteClass = "read" | "add" | "idempotent" | "overwrite" | "administrative"

export type ConfirmRequest = { tool: string; message: string }

/** A fact's value as a template the tool picks, such as `{bytes} bytes`, and the values it holds; the entry point fills them in unquoted. */
export type CallValue = { text: string; values?: Record<string, string | number> }

/** One fact an approval prompt shows of a call, read as `Label: value`. */
export type CallFact = { label: string; value: string | CallValue }

/** A headline template the tool picks, such as `Create the note {name}`, and the values the entry point quotes into it. */
export type CallHeadline = { text: string; values?: Record<string, string> }

/** The text a call carries, under the tool's own label (`Note text`). */
export type CallText = { label: string; body: string }

/**
 * What a call will do, as an approval prompt shows it: an optional headline,
 * short facts, then an optional text. `pins` are values the prompt does not
 * show that the call must still find unchanged (a file's hash), by name; they
 * go into the pin of the approval and nowhere else.
 */
export type CallDescription = {
  headline?: CallHeadline
  facts: CallFact[]
  text?: CallText
  pins?: Record<string, string>
}

/**
 * The kind of value a package's own setting holds: `path` is an absolute path
 * (text), `paths` a list of them.
 */
export type OptionType = "text" | "boolean" | "number" | "list" | "path" | "paths"

/**
 * How a package declares one of its own settings: its type, or an object that
 * adds bounds. `integer` (only `true`) asks for a whole number; `min` and `max`
 * are inclusive and bound a number's value or the count of a list's items. A
 * bound applies to a value that is given, never to a setting left unset. An
 * object with only `type` means the same as the type.
 */
export type OptionSpec =
  | OptionType
  | { type: "number"; integer?: true; min?: number; max?: number }
  | { type: "list" | "paths"; min?: number; max?: number }
  | { type: OptionType }

/** A value of one of the package's own settings. */
export type ToolOptionValue = string | boolean | number | readonly string[]

/** The values of the package's own settings, by name; one not given is absent. */
export type ToolOptions = Readonly<Record<string, ToolOptionValue>>

export type ToolContext = {
  /** The working directory the call runs in. */
  cwd: string
  /** A directory that is never the caller's working tree (where these tools are installed); a tool must refuse to treat it as the caller's tree. */
  ownDir?: string
  /** The package's own settings the call can read, such as a path to a file of rules. */
  options?: ToolOptions
  signal?: AbortSignal
  /** Asks the person to approve; absent when the harness's own approval already covers the call. */
  confirm?(request: ConfirmRequest): Promise<boolean>
}

/** What a grant over a tool can limit: a whole-number ceiling, a yes/no, or a set of allowed values. */
export type BoundSpec =
  | { kind: "max"; description: string }
  | { kind: "allow"; description: string }
  | { kind: "oneOf"; values: readonly string[]; description: string }

/** The bounds a tool declares, by name. */
export type ToolBounds = Readonly<Record<string, BoundSpec>>

/** A call's value for one bound: a number for `max`, a boolean for `allow`, one or more values for `oneOf`. */
export type MeasuredValue = number | boolean | string | readonly string[]

/** A call's value for every bound its tool declares, by name. */
export type CallMeasure = Readonly<Record<string, MeasuredValue>>

export type ToolSpec<I extends z.ZodObject<any> = z.ZodObject<any>, O extends z.ZodObject<any> = z.ZodObject<any>> = {
  /** `<prefix>_<domain>_<verb>`; a public interface, so it never changes once published. */
  id: string
  title: string
  /** What the agent is about to do, as a fixed phrase without values (`About to create a note`); the approval prompt shows it where no headline can stand, and the title where the tool has none. */
  intent?: string
  description: string
  toolset: string
  class: WriteClass
  /** Whether any argument can reach outside the machine (`openWorldHint`); true when absent. */
  openWorld?: boolean
  /** What the call writes to, as the permission rules of an entry point name it. */
  targets?(args: z.output<I>, ctx: ToolContext): string[] | Promise<string[]>
  /**
   * Refuses a call that no approval may let run, by throwing a `ToolError`
   * (usually `not_found` or `forbidden`). It runs before the person is asked
   * and again before `execute`. It should be cheap, and its message should say
   * no more about the target than the arguments already do. Returning means
   * the call may go on.
   */
  gate?(args: z.output<I>, ctx: ToolContext): void | Promise<void>
  /**
   * What the call will do, for the person approving it: a headline template
   * (the intent, else the title, stands without one), facts such as the kind
   * of target, and the text the call carries under the tool's own label.
   */
  describe?(args: z.output<I>, ctx: ToolContext): CallDescription | Promise<CallDescription>
  /** What a grant over this tool can limit; a tool without it never runs under a grant. An empty set lets a grant limit only targets, rate and expiry. */
  bounds?: ToolBounds
  /** This call's value for each bound, computed from what the call carries, never from the model's account of it. */
  measure?(args: z.output<I>, ctx: ToolContext): CallMeasure | Promise<CallMeasure>
  input: I
  output: O
  execute(args: z.output<I>, ctx: ToolContext): Promise<z.input<O>>
}

/** A client meta key that makes the client ask even under an allow rule. */
export const REQUIRES_USER_INTERACTION = "anthropic/requiresUserInteraction"

const TOOL_ID_PATTERN = /^[a-z]+(?:_[a-z]+){2,}$/
const MAX_TOOL_ID_LENGTH = 40
const READ_TOOL_SUFFIX = "_read"
const BOUND_NAME_PATTERN = /^[a-z][a-z0-9_]*$/
const MAX_BOUND_NAME_LENGTH = 40
const BOUND_KINDS: readonly BoundSpec["kind"][] = ["max", "allow", "oneOf"]
/** The most bounds a tool declares: a grant's prompt shows one fact per bound beside its rate and days, within the facts a prompt keeps. */
export const MAX_BOUNDS = 6

function checkBounds(spec: Pick<ToolSpec, "id" | "class" | "bounds" | "measure">): void {
  const { id, bounds } = spec
  if (bounds === undefined) {
    if (spec.measure !== undefined) {
      throw new Error(`Tool "${id}" gives a measure without bounds; declare the bounds it measures, even none.`)
    }
    return
  }
  if (spec.class === "read") {
    throw new Error(`Tool "${id}" is a read tool, which runs without a grant, so it must not declare bounds.`)
  }
  const names = Object.keys(bounds)
  if (names.length > MAX_BOUNDS) {
    throw new Error(
      `Tool "${id}" declares ${names.length} bounds; declare at most ${MAX_BOUNDS}, because a grant's prompt must show every bound.`,
    )
  }
  if (names.length > 0 && spec.measure === undefined) {
    throw new Error(`Tool "${id}" declares bounds, so it must give a measure that computes them.`)
  }
  for (const name of names) {
    const bound = bounds[name]!
    if (!BOUND_NAME_PATTERN.test(name) || name.length > MAX_BOUND_NAME_LENGTH) {
      throw new Error(
        `Tool "${id}" names the bound "${name}"; a bound name is lowercase letters, digits and _, starts with a letter and has at most ${MAX_BOUND_NAME_LENGTH} characters.`,
      )
    }
    if (!BOUND_KINDS.includes(bound.kind)) {
      throw new Error(
        `Bound "${name}" of tool "${id}" has the kind "${String(bound.kind)}"; use ${BOUND_KINDS.join(", ")}.`,
      )
    }
    if (typeof bound.description !== "string" || bound.description.trim() === "") {
      throw new Error(`Bound "${name}" of tool "${id}" must give a description that is not blank.`)
    }
    if (bound.kind === "oneOf") {
      const values: readonly unknown[] = bound.values
      if (!Array.isArray(values) || values.length === 0) {
        throw new Error(`Bound "${name}" of tool "${id}" must list the values a call may use.`)
      }
      if (values.some((value) => typeof value !== "string" || value.trim() === "")) {
        throw new Error(`Bound "${name}" of tool "${id}" must list values that are not blank.`)
      }
      if (new Set(values).size !== values.length) {
        throw new Error(`Bound "${name}" of tool "${id}" lists a value more than once.`)
      }
    }
  }
}

/**
 * Returns the spec after checking what a type cannot: the ID's shape and
 * length, that a read tool is named `_read`, that the output schema is an
 * object (a tool returns its data as a plain object), and that declared
 * `bounds` and `measure` fit each other and the write class. The ID's prefix
 * is the package's to check.
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
  if (spec.intent !== undefined && spec.intent.trim() === "") {
    throw new Error(`Tool "${spec.id}" must give an intent that is not blank, or none.`)
  }
  if (spec.intent !== undefined && /[{}]/.test(spec.intent)) {
    throw new Error(`Tool "${spec.id}" must give an intent without braces: it carries no values.`)
  }
  checkBounds(spec)
  return spec
}

export type ToolAnnotations = {
  title: string
  readOnlyHint: boolean
  destructiveHint?: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

const CLASS_HINTS = {
  read: { readOnlyHint: true, idempotentHint: true },
  add: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
  idempotent: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  overwrite: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
  administrative: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
} as const satisfies Record<WriteClass, Omit<ToolAnnotations, "title" | "openWorldHint">>

/** The MCP annotations of a tool's write class, and whether it reaches outside the machine. */
export function annotations(spec: Pick<ToolSpec, "title" | "class" | "openWorld">): ToolAnnotations {
  return { title: spec.title, ...CLASS_HINTS[spec.class], openWorldHint: spec.openWorld ?? true }
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
 * as strict (`invalid_argument` on a bad or unknown one), runs the tool's
 * `gate` when it has one, executes, and validates the result against the
 * output schema. A result that does not match is a bug in the tool; it throws
 * `internal_error` carrying the raw result, so whatever the call already
 * created stays visible. Errors from `gate` and `execute` pass through
 * unchanged.
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
  await spec.gate?.(args.data as z.output<I>, ctx)
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
