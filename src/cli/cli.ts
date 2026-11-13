import {
  annotations,
  inputJsonSchema,
  invoke,
  isAbortError,
  isToolError,
  outputJsonSchema,
  PIN_PATTERN,
  selectTools,
  ToolError,
  type ErrorCode,
  type ErrorDetails,
  type ToolOptions,
  type ToolSpec,
  type Translations,
} from "../core"
import { errorBody } from "../entry/errors"
import { approvalOf, checkPin } from "../entry/pin"
import { PROJECT_PROFILE, type EntryProfile } from "../entry/profile"
import { parseToolOptions, parseToolSettings, promptLanguage } from "../entry/settings"
import { visible } from "../entry/visible"
import { promptTranslator, promptWords } from "../entry/words"
import { PROJECT } from "../project"

/** The exit codes of a command: it did its work, the work failed, or the command line was wrong. */
export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2

const PROGRAM = PROJECT.cli
const CWD_FLAG = "--cwd"
const LANGUAGE_FLAG = "--language"
const HARNESS_LANGUAGE_FLAG = "--harness-language"
const PIN_FLAG = "--pin"

/** What a command line needs from its surroundings; `main.ts` wires the process, a test supplies its own. */
export type CliIo = {
  /** The tools the command line can select from. */
  specs: ToolSpec[]
  /** Where the `<envPrefix>_*` settings fall back to. */
  env: Record<string, string | undefined>
  /** The settings' environment prefix and the toolsets; defaults to this package's. */
  profile?: EntryProfile
  /** Reads standard input to its end; an empty string when there is none. */
  readStdin(): Promise<string>
  /** Receives the JSON document a command answers with. */
  stdout(text: string): void
  /** Receives usage lines and the detail of unexpected errors. */
  stderr(text: string): void
  /** Where the tools are installed: never a call's working tree. */
  ownDir?: string
  /** Stops a running tool when it aborts. */
  signal?: AbortSignal
  /** How long a call's description may take; defaults to DESCRIBE_TIMEOUT_MS. */
  describeTimeoutMs?: number
  /** The translations of the tools' words, per language, for `target`; defaults to none, which keeps its answer in English. */
  translations?: Translations
}

type Command =
  | { name: "list"; selected: ToolSpec[] }
  | { name: "run"; toolId: string; cwd: string; pin: string | undefined; selected: ToolSpec[]; options: ToolOptions }
  | { name: "target"; toolId: string; cwd: string; language: string | undefined; options: ToolOptions }

function usageError(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** Splits `<flag> <value>` or `<flag>=<value>` from the remaining arguments; the last one given wins. */
function takeFlag(argv: string[], flag: string): { value: string | undefined; rest: string[] } {
  let value: string | undefined
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith(`${flag}=`)) {
      value = arg.slice(flag.length + 1)
    } else if (arg === flag) {
      value = argv[++i]
      if (value === undefined || value.startsWith("--")) throw usageError(`Option ${flag} needs a value.`)
    } else {
      rest.push(arg)
    }
  }
  if (value === "") throw usageError(`Option ${flag} needs a value.`)
  return { value, rest }
}

/** Reads the command line; a mistake in it, in the settings or in the tool selection is `invalid_argument`. */
function parseCommand(argv: string[], io: Pick<CliIo, "specs" | "env" | "profile">): Command {
  const profile = io.profile ?? PROJECT_PROFILE
  const select = (flags: string[]) => {
    const settings = parseToolSettings(flags, io.env, profile)
    return { selected: selectTools(io.specs, settings, profile.toolsets), options: settings.options }
  }
  const [name, ...args] = argv
  if (name === "list") {
    return { name, selected: select(args).selected }
  }
  if (name !== "run" && name !== "target") {
    const given = name === undefined ? "No command given" : `Unknown command "${name}"`
    throw usageError(
      `${given}; use list, run <tool-id> --cwd <dir> [${PIN_FLAG} <hex>] or target <tool-id> --cwd <dir> [${LANGUAGE_FLAG} <tag>] [${HARNESS_LANGUAGE_FLAG} <tag>].`,
    )
  }

  const [toolId, ...options] = args
  if (toolId === undefined || toolId.startsWith("--")) throw usageError(`Command ${name} needs a tool id.`)
  const { value: cwd, rest } = takeFlag(options, CWD_FLAG)
  if (cwd === undefined) throw usageError(`Command ${name} needs ${CWD_FLAG} <dir>.`)
  if (name === "target") {
    const { value: language, rest: afterLanguage } = takeFlag(rest, LANGUAGE_FLAG)
    const { value: harnessLanguage, rest: toolOptions } = takeFlag(afterLanguage, HARNESS_LANGUAGE_FLAG)
    return {
      name,
      toolId,
      cwd,
      language: promptLanguage(language, io.env, harnessLanguage, profile),
      options: parseToolOptions(toolOptions, io.env, profile),
    }
  }
  const { value: pin, rest: selection } = takeFlag(rest, PIN_FLAG)
  if (pin !== undefined && !PIN_PATTERN.test(pin)) {
    throw usageError(`Option ${PIN_FLAG} needs the 64 lowercase hexadecimal digits \`target\` answered with.`)
  }
  return { name, toolId, cwd, pin, ...select(selection) }
}

function describeSpec(spec: ToolSpec) {
  return {
    id: spec.id,
    title: spec.title,
    ...(spec.intent !== undefined && { intent: spec.intent }),
    description: spec.description,
    toolset: spec.toolset,
    class: spec.class,
    annotations: annotations(spec),
    input_schema: inputJsonSchema({ input: spec.input.strict() }),
    output_schema: outputJsonSchema(spec),
  }
}

function writeJson(io: CliIo, document: unknown): void {
  io.stdout(`${JSON.stringify(document)}\n`)
}

function writeError(io: CliIo, code: ErrorCode, message: string, details?: Readonly<ErrorDetails>): number {
  writeJson(io, { error: errorBody(code, message, details) })
  return EXIT_FAILED
}

/** The arguments a command reads from standard input: one JSON object, or none at all. */
async function readArguments(io: CliIo): Promise<unknown> {
  const text = await io.readStdin()
  if (text.trim() === "") return {}
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new ToolError("invalid_argument", "The arguments on standard input are not valid JSON.", { cause: error })
  }
}

async function runTool(command: Extract<Command, { name: "run" }>, io: CliIo): Promise<number> {
  const spec = command.selected.find((candidate) => candidate.id === command.toolId)
  if (!spec) return writeError(io, "invalid_argument", `Unknown tool "${command.toolId}".`)
  try {
    const args = await readArguments(io)
    const ctx = { cwd: command.cwd, ownDir: io.ownDir, options: command.options, signal: io.signal }
    await checkPin(spec, args, ctx, command.pin, io.describeTimeoutMs)
    const result = await invoke(spec, args, ctx)
    writeJson(io, { result })
    return EXIT_OK
  } catch (error) {
    if (isToolError(error)) return writeError(io, error.code, error.message, error.details)
    if (isAbortError(error)) return writeError(io, "internal_error", `${spec.id} was cancelled.`)
    io.stderr(`${PROGRAM}: unexpected error while running ${spec.id}: ${errorDetail(error)}\n`)
    return writeError(io, "internal_error", `Unexpected error while running ${spec.id}; see standard error.`)
  }
}

async function targetOf(command: Extract<Command, { name: "target" }>, io: CliIo): Promise<number> {
  const spec = io.specs.find((candidate) => candidate.id === command.toolId)
  if (!spec) return writeError(io, "invalid_argument", `Unknown tool "${command.toolId}".`)
  try {
    const args = await readArguments(io)
    const ctx = {
      cwd: command.cwd,
      ownDir: io.ownDir,
      options: command.options,
      signal: io.signal,
    }
    const t = promptTranslator(io.translations ?? {}, command.language)
    const approval = await approvalOf(spec, args, ctx, io.describeTimeoutMs, t)
    if (approval.refused) {
      const { code, message, details } = approval.refused
      writeJson(io, { refused: errorBody(code, message, details) })
      return EXIT_OK
    }
    const { resources, description, pin } = approval
    writeJson(io, {
      resources,
      title: visible(t.word(spec.title)),
      ...(spec.intent !== undefined && { intent: visible(t.word(spec.intent)) }),
      words: promptWords(t),
      ...(description !== undefined && { description }),
      ...(pin !== undefined && { pin }),
    })
    return EXIT_OK
  } catch (error) {
    if (isToolError(error)) return writeError(io, error.code, error.message, error.details)
    if (isAbortError(error)) return writeError(io, "internal_error", "The call was cancelled.")
    io.stderr(`${PROGRAM}: unexpected error while resolving the target: ${errorDetail(error)}\n`)
    return writeError(io, "internal_error", "Unexpected error while resolving the target; see standard error.")
  }
}

function errorDetail(error: unknown): string {
  return error instanceof Error ? (error.stack ?? error.message) : String(error)
}

/**
 * The command line of the package, for callers that are not a harness's own
 * plugin: `list` answers with the selected tools, `run` runs one with the
 * arguments on standard input (with `--pin <hex>`, only if what `target`
 * answered with that `pin` is unchanged, else `stale` and nothing runs), and
 * `target` answers with what a call would write to (`{"resources": [...]}`), the tool's `title`, its `intent` when it
 * has one (`list` carries it too, in English), and the plugin's own
 * `words` (`{"details", "target", "more", "more_character",
 * "more_characters"}`, the last two the notices of characters left out, with a
 * `{count}` placeholder) in the prompt language, plus a `description` when the
 * tool gives one:
 * `{"headline"?: string, "facts": [{"label", "value", "omitted"?}], "dropped"?, "text"?: {"label", "body", "omitted"?}}`,
 * as the approval prompt shows it (the words translated, the headline
 * rendered, hidden characters marked; `omitted` is the number of code points
 * a cut value or text left out, and `dropped` the number of facts left out
 * past the eighth, each present only when it is above zero), and a `pin` (64 hex digits, independent of the
 * language) of that description and the resources when there is a description.
 * A call the tool's gate refuses is answered with `{"refused": {"code", "message", "details"?}}`
 * alone and `EXIT_OK`: nothing may let it run, so the caller blocks it without
 * asking. `run` runs the gate too, and fails with its code.
 * `target` takes `--language <tag>`, else `<envPrefix>_LANGUAGE`, else `--harness-language <tag>` (the harness's own
 * display language) as the prompt language; none, or one without a table,
 * keeps English. `list`, `run` and `target` also take the package's tool options,
 * as flags or `<envPrefix>_<OPTION>` variables, and `run` and `target` hand their
 * values to the tool as `options`. Standard output carries only the JSON document; a
 * mistake in the command line is one line on standard error and `EXIT_USAGE`.
 * Resolves to the exit code.
 */
export async function runCli(argv: string[], io: CliIo): Promise<number> {
  let command: Command
  try {
    command = parseCommand(argv, io)
  } catch (error) {
    if (!isToolError(error)) throw error
    io.stderr(`${PROGRAM}: ${error.message}\n`)
    return EXIT_USAGE
  }

  switch (command.name) {
    case "list":
      writeJson(io, command.selected.map(describeSpec))
      return EXIT_OK
    case "run":
      return runTool(command, io)
    case "target":
      return targetOf(command, io)
  }
}
