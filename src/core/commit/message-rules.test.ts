import { describe, expect, test } from "bun:test"
import { displayWidth, lintMessage, type LintOptions } from "./message-rules"

const OPTIONS: LintOptions = { subjectMax: 72, bodyWrap: 72, subjectTarget: 50, conventional: false }

function rules(message: string, options: Partial<LintOptions> = {}): string[] {
  return lintMessage(message, { ...OPTIONS, ...options }).map((violation) => violation.rule)
}

describe("displayWidth", () => {
  test("counts ASCII as one column each", () => {
    expect(displayWidth("feat: add")).toBe(9)
  })

  test("counts wide characters as two columns", () => {
    expect(displayWidth("日本語")).toBe(6)
  })

  test("counts combining marks as none", () => {
    expect(displayWidth("e\u0301")).toBe(1)
  })
})

describe("lintMessage", () => {
  test("returns only empty for a blank message", () => {
    expect(lintMessage(" \n\n", OPTIONS)).toEqual([
      { rule: "empty", severity: "error", message: "The commit message is empty." },
    ])
  })

  test("accepts a clean message", () => {
    expect(rules("Add the thing\n\nWhy it is needed.\n")).toEqual([])
  })

  test("errors on a subject over the hard limit, with its message", () => {
    const found = lintMessage("x".repeat(80), OPTIONS)
    expect(found).toEqual([
      { rule: "subject-hard-max", severity: "error", message: "Subject is 80 columns; the limit is 72." },
    ])
  })

  test("warns on a subject over the target but within the limit", () => {
    const found = lintMessage("x".repeat(60), OPTIONS)
    expect(found).toEqual([
      { rule: "subject-target", severity: "warning", message: "Subject is 60 columns; aim for <= 50." },
    ])
  })

  test("counts wide characters in the subject width", () => {
    expect(rules("日".repeat(30))).toEqual(["subject-target"])
    expect(rules("日".repeat(40))).toEqual(["subject-hard-max"])
  })

  test("errors when line 2 is not blank", () => {
    expect(rules("Subject\nbody")).toEqual(["blank-line"])
    expect(rules("Subject\n\nbody")).toEqual([])
    expect(rules("Subject")).toEqual([])
  })

  test("warns on subject whitespace and a trailing period", () => {
    expect(rules(" Subject ")).toEqual(["subject-whitespace"])
    expect(rules("Subject.")).toEqual(["subject-period"])
    expect(rules("Subject. ")).toEqual(["subject-whitespace", "subject-period"])
  })

  test("normalizes CRLF line endings", () => {
    expect(rules("Subject\r\n\r\nbody\r\n")).toEqual([])
    expect(rules("Subject\r\nbody")).toEqual(["blank-line"])
  })

  test("checks the conventional shape only when enabled", () => {
    expect(rules("Add the thing")).toEqual([])
    expect(rules("Add the thing", { conventional: true })).toEqual(["conventional"])
    expect(rules("feat(api)!: add the thing", { conventional: true })).toEqual([])
  })

  test("exempts merge, revert and autosquash subjects from the conventional shape", () => {
    for (const subject of ["Merge branch 'x'", 'Revert "x"', "fixup! x", "squash! x", "amend! x"]) {
      expect(rules(subject, { conventional: true })).toEqual([])
    }
  })

  test("warns on a body line over the wrap width, naming its line", () => {
    const found = lintMessage(`Subject\n\n${"w".repeat(80)}`, OPTIONS)
    expect(found).toEqual([
      { rule: "body-wrap", severity: "warning", message: "Body line 3 is 80 columns; wrap near 72." },
    ])
    expect(rules(`Subject\n\n${"w".repeat(80)}`, { bodyWrap: 100 })).toEqual([])
  })

  test("does not wrap-check the subject line", () => {
    expect(rules("x".repeat(60), { subjectTarget: 70 })).toEqual([])
  })

  test("exempts fenced blocks from body wrapping", () => {
    const long = "w".repeat(90)
    expect(rules(`Subject\n\n\`\`\`\n${long}\n\`\`\`\n`)).toEqual([])
    expect(rules(`Subject\n\n~~~\n${long}\n~~~\n`)).toEqual([])
    expect(rules(`Subject\n\n\`\`\`\n\`\`\`\n${long}\n`)).toEqual(["body-wrap"])
  })

  test("exempts URLs, list items and table rows from body wrapping", () => {
    const long = "w".repeat(90)
    for (const line of [`https://example.com/${long}`, `  - ${long}`, `* ${long}`, `1. ${long}`, `| ${long}`]) {
      expect(rules(`Subject\n\n${line}`)).toEqual([])
    }
  })
})
