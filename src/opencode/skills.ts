import { readFile, readdir } from "node:fs/promises"
import { join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import type { V2Skill } from "./types"

const SKILL_FILE = "SKILL.md"
const FRONTMATTER = /^---[ \t]*\r?\n([\s\S]*?\r?\n)?---[ \t]*(?:\r?\n|$)/
const KEY_LINE = /^(name|description)[ \t]*:[ \t]*(.*?)[ \t]*$/
/** Where a YAML value stops being a plain one-line scalar this reader understands. */
const UNSUPPORTED_VALUE_START = /^[>|[{&*!%@`]/
const TRAILING_COMMENT = /[ \t]+#.*$/
/** A quoted scalar with nothing after its closing quote but an optional comment. */
const SINGLE_QUOTED = /^'((?:[^']|'')*)'(?:[ \t]+#.*)?$/
const DOUBLE_QUOTED = /^"((?:[^"\\]|\\.)*)"(?:[ \t]+#.*)?$/

/** The `metadata:` line that opens the block: no value, at most a comment. */
const METADATA_OPEN = /^metadata[ \t]*:(?:[ \t]+#.*|[ \t]*)$/
/** A line with nothing in it or only a comment; it never ends a `metadata` block. */
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/
/** The leading whitespace of an indented line, which sets the `metadata` block's own indentation. */
const INDENT = /^[ \t]+/
/** The `toolset` key of a `metadata` block, with its raw value. */
const TOOLSET_LINE = /^toolset[ \t]*:[ \t]*(.*?)[ \t]*$/

type Frontmatter = { name?: string; description?: string; toolset?: string }

/** A skill of the package and the toolset it documents, when it names one. */
export type PackageSkill = { skill: V2Skill; toolset?: string }

function unquote(value: string): string | undefined {
  const single = SINGLE_QUOTED.exec(value)
  if (single) return single[1]!.replaceAll("''", "'")
  const double = DOUBLE_QUOTED.exec(value)
  if (!double) return undefined
  try {
    return JSON.parse(`"${double[1]}"`) as string
  } catch {
    return undefined
  }
}

/** A plain or quoted single-line scalar; anything else (block, flow, anchor, empty) reads as absent. */
function scalar(raw: string): string | undefined {
  if (raw === "" || UNSUPPORTED_VALUE_START.test(raw)) return undefined
  if (raw.startsWith('"') || raw.startsWith("'")) return unquote(raw)
  const text = raw.replace(TRAILING_COMMENT, "").trim()
  return text === "" ? undefined : text
}

/** The `toolset` value of a `metadata` block's child line at the block's own indentation. */
function readToolset(line: string, indent: string): string | undefined {
  if (!line.startsWith(indent)) return undefined
  const match = TOOLSET_LINE.exec(line.slice(indent.length))
  return match ? scalar(match[1]!) : undefined
}

function readFrontmatter(block: string): Frontmatter {
  const found: Frontmatter = {}
  let inMetadata = false
  let indent: string | undefined
  for (const line of block.split(/\r?\n/)) {
    if (inMetadata) {
      if (BLANK_OR_COMMENT.test(line)) continue
      const leading = INDENT.exec(line)?.[0]
      if (leading !== undefined) {
        indent ??= leading
        const toolset = readToolset(line, indent)
        if (toolset !== undefined && leading === indent) found.toolset = toolset
        continue
      }
      inMetadata = false
    }
    if (METADATA_OPEN.test(line)) {
      inMetadata = true
      indent = undefined
      continue
    }
    const match = KEY_LINE.exec(line)
    if (!match) continue
    const value = scalar(match[2]!)
    if (value !== undefined) found[match[1] as "name" | "description"] = value
  }
  return found
}

function parseSkill(directory: string, text: string, path: string): PackageSkill {
  const match = FRONTMATTER.exec(text)
  const { name, description, toolset }: Frontmatter = match ? readFrontmatter(match[1] ?? "") : {}
  const id = name ?? directory
  return {
    skill: {
      id,
      name: id,
      ...(description !== undefined && { description }),
      path,
      content: match ? text.slice(match[0].length) : text,
    },
    ...(toolset !== undefined && { toolset }),
  }
}

/** Whether a file system error says the path is not there (or has a file where a folder should be). */
function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code
  return code === "ENOENT" || code === "ENOTDIR"
}

async function readSkillFile(path: string): Promise<string | undefined> {
  try {
    return await readFile(path, "utf8")
  } catch (error) {
    if (isMissing(error)) return undefined
    throw error
  }
}

/**
 * Reads every `<dir>/<skill>/SKILL.md` as a skill. The id and name are the
 * frontmatter `name` (the folder's name when it has none), the description is
 * the frontmatter `description`, and the content is what follows the
 * frontmatter. Only plain and quoted single-line values are read. A missing or
 * empty directory gives no skills, and a folder without a `SKILL.md` is skipped.
 * When two folders give the same id, the first in folder order wins. A skill
 * links to a toolset with `toolset` in a frontmatter `metadata` block.
 */
export async function readSkills(dir: URL | string): Promise<PackageSkill[]> {
  const root = resolve(typeof dir === "string" ? dir : fileURLToPath(dir))
  let entries: string[]
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => !entry.isFile())
      .map((entry) => entry.name)
  } catch (error) {
    if (isMissing(error)) return []
    throw error
  }

  const skills = new Map<string, PackageSkill>()
  for (const directory of entries.sort()) {
    const path = join(root, directory, SKILL_FILE)
    const text = await readSkillFile(path)
    if (text === undefined) continue
    const found = parseSkill(directory, text, path)
    if (!skills.has(found.skill.id)) skills.set(found.skill.id, found)
  }
  return [...skills.values()]
}

/**
 * The skills of {@link readSkills} that belong to `toolsets`: a skill linked to
 * a toolset outside the set is dropped, a skill with no link is always kept,
 * and without `toolsets` every skill is kept. A dropped skill still claims its
 * id, so a later skill of the same id does not take its place.
 */
export async function loadSkills(dir: URL | string, toolsets?: ReadonlySet<string>): Promise<V2Skill[]> {
  return (await readSkills(dir))
    .filter(({ toolset }) => toolsets === undefined || toolset === undefined || toolsets.has(toolset))
    .map(({ skill }) => skill)
}
