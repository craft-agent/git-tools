import { describe, expect, test } from "bun:test"
import {
  publishedTextFindings,
  publishedTextFindingSchema,
  type PublishedText,
  type PublishedTextRule,
} from "./published-text"

const SHA = "0123456789abcdef0123456789abcdef01234567"
const OTHER_SHA = "fedcba9876543210fedcba9876543210fedcba98"

const wip: PublishedTextRule = { rule: "no-wip", pattern: /wip/i, hint: "Name the change." }
const draft: PublishedTextRule = { rule: "no-draft", pattern: /draft/, hint: "Say what it does." }

const branch = (name: string): PublishedText => ({ field: "branch", branch: name, text: name })
const subject = (text: string, sha = SHA, on = "feature"): PublishedText => ({
  field: "subject",
  branch: on,
  sha,
  text,
})

describe("publishedTextFindings", () => {
  test("no rules or no texts give no findings", () => {
    expect(publishedTextFindings([], [branch("wip"), subject("wip")])).toEqual([])
    expect(publishedTextFindings([wip], [])).toEqual([])
  })

  test("a branch name that matches is a finding with no sha", () => {
    expect(publishedTextFindings([wip], [branch("feature/wip-login")])).toEqual([
      {
        rule: "no-wip",
        field: "branch",
        branch: "feature/wip-login",
        sha: null,
        match: "wip",
        hint: "Name the change.",
        fingerprint: "no-wip:branch:feature/wip-login",
      },
    ])
  })

  test("a subject that matches is a finding with the short sha and the branch it is pushed with", () => {
    expect(publishedTextFindings([wip], [subject("WIP: add login")])).toEqual([
      {
        rule: "no-wip",
        field: "subject",
        branch: "feature",
        sha: SHA.slice(0, 12),
        match: "WIP",
        hint: "Name the change.",
        fingerprint: `no-wip:commit:${SHA.slice(0, 12)}`,
      },
    ])
  })

  test("a text that matches nothing gives nothing", () => {
    expect(publishedTextFindings([wip, draft], [branch("main"), subject("Add login")])).toEqual([])
  })

  test("a rule is case-sensitive unless it has the i flag", () => {
    expect(publishedTextFindings([draft], [subject("Draft")])).toEqual([])
    expect(publishedTextFindings([draft], [subject("draft")])).toHaveLength(1)
  })

  test("a rule reports once per text however often it matches, and the first match", () => {
    const [finding, ...rest] = publishedTextFindings([wip], [subject("wip then WIP again")])
    expect(rest).toEqual([])
    expect(finding!.match).toBe("wip")
  })

  test("a rule with the g flag still reports the first match, and every text is matched from its start", () => {
    const global: PublishedTextRule = { rule: "no-wip", pattern: /wip/g, hint: "x" }
    const findings = publishedTextFindings([global], [subject("wip wip", SHA), subject("wip", OTHER_SHA)])
    expect(findings.map((finding) => finding.match)).toEqual(["wip", "wip"])
  })

  test("findings come in text order, then rule order", () => {
    const findings = publishedTextFindings([draft, wip], [subject("wip draft", SHA), branch("wip-draft")])
    expect(findings.map((finding) => finding.fingerprint)).toEqual([
      `no-draft:commit:${SHA.slice(0, 12)}`,
      `no-wip:commit:${SHA.slice(0, 12)}`,
      "no-draft:branch:wip-draft",
      "no-wip:branch:wip-draft",
    ])
  })

  test("a match is cut to 60 characters with an ellipsis", () => {
    const long: PublishedTextRule = { rule: "long", pattern: /a+/, hint: "x" }
    const [finding] = publishedTextFindings([long], [subject("a".repeat(100))])
    expect(finding!.match).toBe(`${"a".repeat(59)}…`)
    expect(Array.from(finding!.match)).toHaveLength(60)
    const [exact] = publishedTextFindings([long], [subject("a".repeat(60))])
    expect(exact!.match).toBe("a".repeat(60))
  })

  test("a commit pushed with several branches is reported once, under the first", () => {
    const findings = publishedTextFindings(
      [wip],
      [subject("wip", SHA, "first"), subject("wip", SHA, "second"), subject("wip", OTHER_SHA, "second")],
    )
    expect(findings.map((finding) => [finding.branch, finding.sha])).toEqual([
      ["first", SHA.slice(0, 12)],
      ["second", OTHER_SHA.slice(0, 12)],
    ])
  })

  test("the same branch twice is reported once", () => {
    expect(publishedTextFindings([wip], [branch("wip"), branch("wip")])).toHaveLength(1)
  })

  test("a subject without a sha is a mistake of the caller", () => {
    expect(() => publishedTextFindings([wip], [{ field: "subject", branch: "feature", text: "wip" }])).toThrow("sha")
  })

  test("a finding matches its schema", () => {
    for (const finding of publishedTextFindings([wip], [branch("wip"), subject("wip")])) {
      expect(publishedTextFindingSchema.safeParse(finding).success).toBe(true)
    }
  })
})
