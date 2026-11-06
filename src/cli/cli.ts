import {
  annotations,
  inputJsonSchema,
  invoke,
  isAbortError,
  isToolError,
  outputJsonSchema,
  selectTools,
  ToolError,
  type ErrorCode,
  type ToolSpec,
} from "../core"
import { permissionResources } from "../entry/permission"
import { PROJECT_PROFILE, type EntryProfile } from "../entry/profile"
import { parseToolSettings } from "../entry/settings"
import { PROJECT } from "../project"

/** The exit codes of a command: it did its work, the work failed, or the command line was wrong. */
export const EXIT_OK = 0
export const EXIT_FAILED = 1
export const EXIT_USAGE = 2

const PROGRAM = PROJECT.cli
const CWD_FLAG = "--cwd"

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
}

type Command =
  | { name: "list"; selected: ToolSpec[] }
  | { name: "run"; toolId: string; cwd: string; selected: ToolSpec[] }
  | { name: "target"; toolId: string; cwd: string }

function usageError(message: string): ToolError {
  return new ToolError("invalid_argument", message)
}

/** Splits `--cwd <dir>` from the remaining arguments, which are the settings flags. */
function takeCwd(argv: string[]): { cwd: string | undefined; rest: string[] } {
  let cwd: string | undefined
  const rest: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg.startsWith(`${CWD_FLAG}=`)) {
      cwd = arg.slice(CWD_FLAG.length + 1)
    } else if (arg === CWD_FLAG) {
      cwd = argv[++i]
      if (cwd === undefined || cwd.startsWith("--")) throw usageError(`Option ${CWD_FLAG} needs a value.`)
    } else {
      rest.push(arg)
    }
  }
  if (cwd === "") throw usageError(`Option ${CWD_FLAG} needs a value.`)
  return { cwd, rest }
}

/** Reads the command line; a mistake in it, in the settings or in the tool selection is `invalid_argument`. */
function parseCommand(argv: string[], io: Pick<CliIo, "specs" | "env" | "profile">): Command {
  const profile = io.profile ?? PROJECT_PROFILE
  const select = (flags: string[]) => selectTools(io.specs, parseToolSettings(flags, io.env, profile), profile.toolsets)
  const [name, ...args] = argv
  if (name === "list") {
    return { name, selected: select(args) }
  }
  if (name !== "run" && name !== "target") {
    const given = name === undefined ? "No command given" : `Unknown command "${name}"`
    throw usageError(`${given}; use list, run <tool-id> --cwd <dir> or target <tool-id> --cwd <dir>.`)
  }

  const [toolId, ...options] = args
  if (toolId === undefined || toolId.startsWith("--")) throw usageError(`Command ${name} needs a tool id.`)
  const { cwd, rest } = takeCwd(options)
  if (cwd === undefined) throw usageError(`Command ${name} needs ${CWD_FLAG} <dir>.`)
  if (name === "target") {
    if (rest.length > 0) throw usageError(`Unknown option "${rest[0]}".`)
    return { name, toolId, cwd }
  }
  return { name, toolId, cwd, selected: select(rest) }
}

function describeSpec(spec: ToolSpec) {
  return {
    id: spec.id,
    title: spec.title,
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

function writeError(io: CliIo, code: ErrorCode, message: string): number {
  writeJson(io, { error: { code, message } })
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
    const result = await invoke(spec, await readArguments(io), {
      cwd: command.cwd,
      ownDir: io.ownDir,
      signal: io.signal,
    })
    writeJson(io, { result })
    return EXIT_OK
  } catch (error) {
    if (isToolError(error)) return writeError(io, error.code, error.message)
    if (isAbortError(error)) return writeError(io, "internal_error", `${spec.id} was cancelled.`)
    io.stderr(`${PROGRAM}: unexpected error while running ${spec.id}: ${errorDetail(error)}\n`)
    return writeError(io, "internal_error", `Unexpected error while running ${spec.id}; see standard error.`)
  }
}

async function targetOf(command: Extract<Command, { name: "target" }>, io: CliIo): Promise<number> {
  const spec = io.specs.find((candidate) => candidate.id === command.toolId)
  if (!spec) return writeError(io, "invalid_argument", `Unknown tool "${command.toolId}".`)
  try {
    const resources = await permissionResources(spec, await readArguments(io), {
      cwd: command.cwd,
      ownDir: io.ownDir,
      signal: io.signal,
    })
    writeJson(io, { resources })
    return EXIT_OK
  } catch (error) {
    if (isToolError(error)) return writeError(io, error.code, error.message)
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
 * arguments on standard input, and `target` answers with what a call would
 * write to (`{"resources": [...]}`). Standard output carries only the JSON document; a
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
