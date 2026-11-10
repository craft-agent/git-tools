import { ToolError, type ToolOptions, type ToolSettings, type Toolsets } from "../core"
import { PROJECT } from "../project"
import { PROJECT_PROFILE, type EntryProfile } from "./profile"

/** Who asks the person before an administrative tool acts: the harness, or the tool through the client's form. */
export type ConfirmMode = "harness" | "elicitation"

/** The tool settings, who confirms, and the values of the package's own settings (`options`, possibly empty). */
export type EntrySettings = ToolSettings & { confirm: ConfirmMode; options: ToolOptions }

const CONFIRM_MODES: readonly ConfirmMode[] = ["harness", "elicitation"]
const ALL_TOOLSETS = "all"
const TRUE_VALUES: readonly string[] = ["1", "true"]
const FALSE_VALUES: readonly string[] = ["0", "false"]

type OptionName = "toolsets" | "read_only" | "tools" | "exclude_tools" | "confirm"

/** A setting's command-line flag and the end of its environment variable, which follows the profile's prefix; a boolean flag takes no value. */
type Option = { flag: string; envSuffix: string; boolean?: true }

const OPTIONS: Record<OptionName, Option> = {
  toolsets: { flag: "--toolsets", envSuffix: "TOOLSETS" },
  read_only: { flag: "--read-only", envSuffix: "READ_ONLY", boolean: true },
  tools: { flag: "--tools", envSuffix: "TOOLS" },
  exclude_tools: { flag: "--exclude-tools", envSuffix: "EXCLUDE_TOOLS" },
  confirm: { flag: "--confirm", envSuffix: "CONFIRM" },
}

/** The settings every entry point takes, then the profile's tool options, whose flag is the name with `_` as `-` and whose variable ends in the name uppercased. */
function settingOptions(profile: EntryProfile): Record<string, Option> {
  const toolOptions = profile.options.map((name): [string, Option] => [
    name,
    { flag: `--${name.replace(/_/g, "-")}`, envSuffix: name.toUpperCase() },
  ])
  return { ...OPTIONS, ...Object.fromEntries(toolOptions) }
}

function envName(name: string, profile: EntryProfile): string {
  return `${profile.envPrefix}_${settingOptions(profile)[name]!.envSuffix}`
}

/** The environment variables the settings are read from, in the order the settings are listed, the profile's tool options last. */
export function settingVariables(profile: EntryProfile = PROJECT_PROFILE): string[] {
  return Object.keys(settingOptions(profile)).map((name) => envName(name, profile))
}

/** The environment variables a harness that forwards only named variables must pass the server: the settings' variables, then the package's `toolVariables`. */
export function forwardedVariables(
  profile: EntryProfile = PROJECT_PROFILE,
  toolVariables: readonly string[] = PROJECT.toolVariables,
): string[] {
  return [...settingVariables(profile), ...toolVariables]
}

function readFlags(argv: string[], profile: EntryProfile): Record<string, string> {
  const options = settingOptions(profile)
  const byFlag = new Map(Object.entries(options).map(([name, option]) => [option.flag, { name, ...option }]))
  const given: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    const equals = arg.indexOf("=")
    const flag = equals === -1 ? arg : arg.slice(0, equals)
    const option = byFlag.get(flag)
    if (!arg.startsWith("--") || !option) throw new ToolError("invalid_argument", `Unknown option "${arg}".`)
    if (option.boolean) {
      if (equals !== -1) throw new ToolError("invalid_argument", `Option ${flag} takes no value.`)
      given[option.name] = "true"
      continue
    }
    const value = equals === -1 ? argv[++i] : arg.slice(equals + 1)
    if (value === undefined || (equals === -1 && value.startsWith("--"))) {
      throw new ToolError("invalid_argument", `Option ${flag} needs a value.`)
    }
    given[option.name] = value
  }
  return given
}

function splitList(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter((item) => item !== "")
}

function checkToolsets(names: string[], source: string, toolsets: Toolsets): string[] | "all" | undefined {
  if (names.includes(ALL_TOOLSETS)) return ALL_TOOLSETS
  const unknown = names.find((name) => !toolsets.names.includes(name))
  if (unknown !== undefined) {
    const known =
      toolsets.names.length > 0
        ? `use one of ${toolsets.names.join(", ")} or "${ALL_TOOLSETS}"`
        : "no toolsets are defined"
    throw new ToolError("invalid_argument", `Unknown toolset "${unknown}" in ${source}; ${known}.`)
  }
  return names.length ? names : undefined
}

function parseBoolean(value: string, source: string): boolean {
  const text = value.trim().toLowerCase()
  if (TRUE_VALUES.includes(text)) return true
  if (FALSE_VALUES.includes(text)) return false
  throw new ToolError(
    "invalid_argument",
    `Unknown value "${value}" in ${source}; use one of ${[...TRUE_VALUES, ...FALSE_VALUES].join(", ")}.`,
  )
}

function parseConfirm(value: string, source: string): ConfirmMode {
  const mode = CONFIRM_MODES.find((candidate) => candidate === value)
  if (!mode) {
    throw new ToolError(
      "invalid_argument",
      `Unknown confirm mode "${value}" in ${source}; use one of ${CONFIRM_MODES.join(", ")}.`,
    )
  }
  return mode
}

/** A setting given as text, and where it came from, for error messages. */
type SettingText = { text: string; source: string }

function envText(
  name: string,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): SettingText | undefined {
  const variable = envName(name, profile)
  const text = env[variable]
  return text === undefined || text.trim() === "" ? undefined : { text, source: variable }
}

/** The values of the profile's tool options from the flags given and the environment: trimmed, a flag first, blank meaning unset. */
function optionsFrom(
  flags: Record<string, string>,
  env: Record<string, string | undefined>,
  profile: EntryProfile,
): ToolOptions {
  const options: Record<string, string> = {}
  for (const name of profile.options) {
    const text = nonBlank(flags[name] ?? envText(name, env, profile)?.text)
    if (text !== undefined) options[name] = text
  }
  return options
}

/**
 * Reads the settings every entry point takes from its command line and
 * environment (`<envPrefix>_<SETTING>` variables). A flag wins over its
 * environment variable; an empty list item is dropped. The profile's tool
 * options are read the same way as text (trimmed, blank meaning unset) into
 * `options`. A mistake is `invalid_argument` naming the culprit.
 */
export function parseSettings(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): EntrySettings {
  const flags = readFlags(argv, profile)
  const value = (name: OptionName): SettingText | undefined =>
    flags[name] !== undefined ? { text: flags[name], source: OPTIONS[name].flag } : envText(name, env, profile)

  const settings: EntrySettings = { confirm: "harness", options: optionsFrom(flags, env, profile) }
  const toolsets = value("toolsets")
  if (toolsets) settings.toolsets = checkToolsets(splitList(toolsets.text), toolsets.source, profile.toolsets)
  const readOnly = value("read_only")
  if (readOnly) settings.read_only = parseBoolean(readOnly.text, readOnly.source)
  const tools = value("tools")
  if (tools) settings.tools = splitList(tools.text)
  const excluded = value("exclude_tools")
  if (excluded) settings.exclude_tools = splitList(excluded.text)
  const confirm = value("confirm")
  if (confirm) settings.confirm = parseConfirm(confirm.text.trim(), confirm.source)
  return settings
}

/**
 * Reads the tool settings from a command line that has no `confirm` setting,
 * for entry points whose caller does the confirming: `--confirm` is
 * `invalid_argument`, and `<envPrefix>_CONFIRM` is ignored. Everything else
 * is read as `parseSettings` reads it, the tool options included.
 */
export function parseToolSettings(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): ToolSettings & { options: ToolOptions } {
  const { flag } = OPTIONS.confirm
  if (argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`))) {
    throw new ToolError("invalid_argument", `Option ${flag} is not available here.`)
  }
  const { confirm: _confirm, ...settings } = parseSettings(
    argv,
    { ...env, [envName("confirm", profile)]: undefined },
    profile,
  )
  return settings
}

/**
 * Reads only the tool options from a command line, for a command that takes
 * no other setting: a flag for anything but a tool option is `invalid_argument`
 * as an unknown option. Read as `parseSettings` reads them.
 */
export function parseToolOptions(
  argv: string[],
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): ToolOptions {
  const flags = readFlags(argv, profile)
  const other = Object.keys(flags).find((name) => !profile.options.includes(name))
  if (other !== undefined) {
    throw new ToolError("invalid_argument", `Unknown option "${settingOptions(profile)[other]!.flag}".`)
  }
  return optionsFrom(flags, env, profile)
}

const TOOL_OPTION_NAMES = ["toolsets", "read_only", "tools", "exclude_tools"] as const satisfies readonly OptionName[]
type ToolOptionName = (typeof TOOL_OPTION_NAMES)[number]

function stringList(value: unknown): string[] | undefined {
  return Array.isArray(value) && value.every((item): item is string => typeof item === "string") ? value : undefined
}

function optionError(name: string, expected: string): ToolError {
  return new ToolError("invalid_argument", `Option "${name}" must be ${expected}.`)
}

function toolsetsOption(value: unknown, toolsets: Toolsets): string[] | "all" | undefined {
  if (value === ALL_TOOLSETS) return ALL_TOOLSETS
  const names = stringList(value)
  if (!names) throw optionError("toolsets", `a list of toolset names or "${ALL_TOOLSETS}"`)
  return checkToolsets(names, 'option "toolsets"', toolsets)
}

function booleanOption(value: unknown): boolean {
  if (typeof value !== "boolean") throw optionError("read_only", "true or false")
  return value
}

function listOption(name: "tools" | "exclude_tools"): (value: unknown) => string[] {
  return (value) => {
    const list = stringList(value)
    if (!list) throw optionError(name, "a list of tool ids")
    return list
  }
}

const LANGUAGE_OPTION = "language"

function pluginOptionNames(profile: EntryProfile): readonly string[] {
  return [...TOOL_OPTION_NAMES, LANGUAGE_OPTION, ...profile.options]
}

/** The environment variable of the `language` setting: `<envPrefix>_LANGUAGE`. */
export function languageVariable(profile: EntryProfile = PROJECT_PROFILE): string {
  return `${profile.envPrefix}_LANGUAGE`
}

/** The tool settings, the values of the package's own settings (`options`, possibly empty) and the language of a native plugin's approval prompt, as given (matched later against the package's translations). */
export type PluginSettings = ToolSettings & { options: ToolOptions; language?: string }

function nonBlank(text: string | undefined): string | undefined {
  const trimmed = text?.trim()
  return trimmed === "" ? undefined : trimmed
}

/** The language of the prompt from a command line's `--language` value, else `<envPrefix>_LANGUAGE`, else the harness's own display language; blank values count as unset. */
export function promptLanguage(
  flag: string | undefined,
  env: Record<string, string | undefined>,
  harness: string | undefined,
  profile: EntryProfile = PROJECT_PROFILE,
): string | undefined {
  return nonBlank(flag) ?? nonBlank(env[languageVariable(profile)]) ?? nonBlank(harness)
}

function languageOption(value: unknown): string | undefined {
  if (typeof value !== "string") throw optionError(LANGUAGE_OPTION, 'a language tag such as "ja"')
  return nonBlank(value)
}

function textOption(name: string, value: unknown): string | undefined {
  if (typeof value !== "string") throw optionError(name, "text")
  return nonBlank(value)
}

/**
 * Reads the tool settings, the prompt language and the profile's tool options
 * from the options a plugin is configured with, for entry points that have no
 * command line. An option wins over its environment variable (`language`
 * falls back to `<envPrefix>_LANGUAGE`, blank meaning unset, and is not
 * checked against any list; a tool option is text, trimmed, blank meaning
 * unset); an option of the wrong type, or one this function does not know, is
 * `invalid_argument` naming it. `confirm` is not an option here: the harness
 * asks.
 */
export function settingsFromOptions(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined>,
  profile: EntryProfile = PROJECT_PROFILE,
): PluginSettings {
  const given = options ?? {}
  const names = pluginOptionNames(profile)
  const unknown = Object.keys(given).find((name) => !names.includes(name))
  if (unknown !== undefined) {
    throw new ToolError("invalid_argument", `Unknown option "${unknown}"; use one of ${names.join(", ")}.`)
  }

  const resolve = <T>(
    name: ToolOptionName,
    fromOption: (value: unknown) => T,
    fromText: (text: SettingText) => T,
  ): T | undefined => {
    if (given[name] !== undefined) return fromOption(given[name])
    const text = envText(name, env, profile)
    return text !== undefined ? fromText(text) : undefined
  }

  const toolOptions: Record<string, string> = {}
  for (const name of profile.options) {
    const text = given[name] !== undefined ? textOption(name, given[name]) : nonBlank(envText(name, env, profile)?.text)
    if (text !== undefined) toolOptions[name] = text
  }

  const settings: PluginSettings = { options: toolOptions }
  const toolsets = resolve(
    "toolsets",
    (value) => toolsetsOption(value, profile.toolsets),
    ({ text, source }) => checkToolsets(splitList(text), source, profile.toolsets),
  )
  if (toolsets !== undefined) settings.toolsets = toolsets
  const readOnly = resolve("read_only", booleanOption, ({ text, source }) => parseBoolean(text, source))
  if (readOnly !== undefined) settings.read_only = readOnly
  const tools = resolve("tools", listOption("tools"), ({ text }) => splitList(text))
  if (tools !== undefined) settings.tools = tools
  const excluded = resolve("exclude_tools", listOption("exclude_tools"), ({ text }) => splitList(text))
  if (excluded !== undefined) settings.exclude_tools = excluded
  const language =
    given[LANGUAGE_OPTION] !== undefined
      ? languageOption(given[LANGUAGE_OPTION])
      : promptLanguage(undefined, env, undefined, profile)
  if (language !== undefined) settings.language = language
  return settings
}
