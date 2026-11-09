/** The subject width in columns that draws an error when no limit is given. */
export const DEFAULT_SUBJECT_MAX = 72
/** The body width in columns that draws a warning when no width is given. */
export const DEFAULT_BODY_WRAP = 72
/** The narrowest subject limit or body width a caller may ask for. */
export const MIN_WIDTH = 20
/** The widest subject limit or body width a caller may ask for. */
export const MAX_WIDTH = 200
/** The lowest subject target, and the target when the history gives too little to infer one. */
export const SUBJECT_TARGET_MIN = 50
/** The highest subject target, however long the history's subjects run. */
export const SUBJECT_TARGET_MAX = 60

/** The `type(scope): summary` shape of a conventional subject. */
export const CONVENTIONAL_PATTERN = /^[a-z]+(\([^)]+\))?!?: .+/
const MERGE_OR_REVERT_PATTERN = /^(Merge|Revert)\b/
const AUTOSQUASH_PATTERN = /^(?:fixup|squash|amend)! /
const FENCE_PATTERN = /^\s*(```|~~~)/
const WRAP_EXEMPT_PATTERN = /^\s*(https?:\/\/|[-*]\s|\d+\.\s|\|)/

// East Asian Wide and Fullwidth ranges: a terminal and `git log` give each two columns.
const WIDE_RE =
  /[\u{1100}-\u{115F}\u{231A}\u{231B}\u{23E9}-\u{23EC}\u{23F0}\u{23F3}\u{25FD}\u{25FE}\u{2614}\u{2615}\u{2648}-\u{2653}\u{267F}\u{2693}\u{26A1}\u{26AA}\u{26AB}\u{26BD}\u{26BE}\u{26C4}\u{26C5}\u{26CE}\u{26D4}\u{26EA}\u{26F2}\u{26F3}\u{26F5}\u{26FA}\u{26FD}\u{2705}\u{270A}\u{270B}\u{2728}\u{274C}\u{274E}\u{2753}-\u{2755}\u{2757}\u{2795}-\u{2797}\u{27B0}\u{27BF}\u{2B1B}\u{2B1C}\u{2B50}\u{2B55}\u{2E80}-\u{303E}\u{3041}-\u{33FF}\u{3400}-\u{4DBF}\u{4E00}-\u{9FFF}\u{A000}-\u{A4CF}\u{AC00}-\u{D7A3}\u{F900}-\u{FAFF}\u{FE30}-\u{FE4F}\u{FF00}-\u{FF60}\u{FFE0}-\u{FFE6}\u{1F300}-\u{1F64F}\u{1F680}-\u{1F6FF}\u{1F900}-\u{1F9FF}\u{1FA70}-\u{1FAFF}\u{20000}-\u{3FFFD}]/u
// Combining marks, zero-width joiners and variation selectors take no column.
const ZERO_WIDTH_RE = /[\u{0300}-\u{036F}\u{200B}-\u{200D}\u{FE00}-\u{FE0F}\u{20D0}-\u{20FF}]/u

/** Columns the text takes in a terminal: wide and fullwidth characters count two, combining marks none. */
export function displayWidth(text: string): number {
  let width = 0
  for (const ch of text) width += ZERO_WIDTH_RE.test(ch) ? 0 : WIDE_RE.test(ch) ? 2 : 1
  return width
}

/** One problem a check found; an error stops the commit, a warning is advice. */
export type Violation = { rule: string; severity: "error" | "warning"; message: string }

/** What `lintMessage` checks a message against. */
export type LintOptions = {
  /** The subject width in columns above which it is an error. */
  subjectMax: number
  /** The body line width in columns above which it is a warning. */
  bodyWrap: number
  /** The subject width in columns above which it is a warning. */
  subjectTarget: number
  /** Whether to check the `type(scope): summary` shape. */
  conventional: boolean
}

/** Whether a subject is a merge, a revert or an autosquash commit, which the conventional shape does not apply to. */
export function isExemptFromShape(subject: string): boolean {
  return MERGE_OR_REVERT_PATTERN.test(subject) || AUTOSQUASH_PATTERN.test(subject)
}

/** The built-in rules for a commit message: pure, no repository involved. */
export function lintMessage(message: string, options: LintOptions): Violation[] {
  const lines = message.replace(/\r\n/g, "\n").split("\n")
  if (lines.every((line) => line.trim() === "")) {
    return [{ rule: "empty", severity: "error", message: "The commit message is empty." }]
  }
  const violations: Violation[] = []
  const subject = lines[0] ?? ""
  const subjectWidth = displayWidth(subject)
  if (subjectWidth > options.subjectMax) {
    violations.push({
      rule: "subject-hard-max",
      severity: "error",
      message: `Subject is ${subjectWidth} columns; the limit is ${options.subjectMax}.`,
    })
  } else if (subjectWidth > options.subjectTarget) {
    violations.push({
      rule: "subject-target",
      severity: "warning",
      message: `Subject is ${subjectWidth} columns; aim for <= ${options.subjectTarget}.`,
    })
  }
  if (lines.length > 1 && lines[1]!.trim() !== "") {
    violations.push({
      rule: "blank-line",
      severity: "error",
      message: "Missing blank line between subject and body.",
    })
  }
  if (subject !== subject.trim()) {
    violations.push({
      rule: "subject-whitespace",
      severity: "warning",
      message: "Subject has leading or trailing whitespace.",
    })
  }
  if (subject.trim().endsWith(".")) {
    violations.push({ rule: "subject-period", severity: "warning", message: "Subject ends with a period." })
  }
  if (options.conventional && !CONVENTIONAL_PATTERN.test(subject) && !isExemptFromShape(subject)) {
    violations.push({
      rule: "conventional",
      severity: "warning",
      message: "Subject is not `type(scope): summary`.",
    })
  }
  let inFence = false
  for (let index = 2; index < lines.length; index++) {
    const line = lines[index]!
    if (FENCE_PATTERN.test(line)) {
      inFence = !inFence
      continue
    }
    if (inFence || WRAP_EXEMPT_PATTERN.test(line)) continue
    const width = displayWidth(line)
    if (width > options.bodyWrap) {
      violations.push({
        rule: "body-wrap",
        severity: "warning",
        message: `Body line ${index + 1} is ${width} columns; wrap near ${options.bodyWrap}.`,
      })
    }
  }
  return violations
}
