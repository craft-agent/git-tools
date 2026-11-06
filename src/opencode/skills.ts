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

type Frontmatter = { name?: string; description?: string }

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

function readFrontmatter(block: string): Frontmatter {
  const found: Frontmatter = {}
  for (const line of block.split(/\r?\n/)) {
    const match = KEY_LINE.exec(line)
    if (!match) continue
    const value = scalar(match[2]!)
    if (value !== undefined) found[match[1] as keyof Frontmatter] = value
  }
  return found
}

function parseSkill(directory: string, text: string, path: string): V2Skill {
  const match = FRONTMATTER.exec(text)
  const { name, description }: Frontmatter = match ? readFrontmatter(match[1] ?? "") : {}
  const id = name ?? directory
  return {
    id,
    name: id,
    ...(description !== undefined && { description }),
    path,
    content: match ? text.slice(match[0].length) : text,
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
 * When two folders give the same id, the first in folder order wins.
 */
export async function loadSkills(dir: URL | string): Promise<V2Skill[]> {
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

  const skills = new Map<string, V2Skill>()
  for (const directory of entries.sort()) {
    const path = join(root, directory, SKILL_FILE)
    const text = await readSkillFile(path)
    if (text === undefined) continue
    const skill = parseSkill(directory, text, path)
    if (!skills.has(skill.id)) skills.set(skill.id, skill)
  }
  return [...skills.values()]
}
