import { describe, expect, test } from "bun:test"
import { diffOf, PREFIXED, randomish, rulesOf } from "../../testing/secret-fixtures"
import { scanDiff } from "./secret-diff"

describe("scanDiff", () => {
  const secret = PREFIXED["github-pat"]!

  test("gitleaks:allow skips every builtin rule", () => {
    expect(rulesOf("a.ts", `v = "${secret}" // gitleaks:allow`)).toEqual([])
    expect(rulesOf(".env", `AUTH_TOKEN=${randomish(32)} # gitleaks:allow`)).toEqual([])
  })

  test("removed lines and context lines are never scanned", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -3,2 +3,2 @@",
      ` context ${secret}`,
      `-removed ${secret}`,
      "+added safely",
      "",
    ].join("\n")
    expect(scanDiff(diff)).toEqual([])
  })

  test("line numbers follow the hunk headers on the new side", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -2,2 +2,3 @@",
      " keep",
      "-gone",
      "+one",
      `+v = "${secret}"`,
      "@@ -20 +21 @@",
      "-before",
      `+w = "${secret}"`,
      "\\ No newline at end of file",
      "diff --git a/b.ts b/b.ts",
      "--- a/b.ts",
      "+++ b/b.ts",
      "@@ -0,0 +7 @@",
      `+v = "${secret}"`,
      "",
    ].join("\n")
    expect(scanDiff(diff).map((f) => [f.file, f.line])).toEqual([
      ["a.ts", 4],
      ["a.ts", 21],
      ["b.ts", 7],
    ])
  })

  test("an added line that looks like a file header is content, not a header", () => {
    const diff = [
      "diff --git a/a.ts b/a.ts",
      "--- a/a.ts",
      "+++ b/a.ts",
      "@@ -0,0 +1,2 @@",
      `+++ ${secret}`,
      "+++ b/other.ts",
      "",
    ].join("\n")
    expect(scanDiff(diff).map((f) => [f.file, f.line])).toEqual([["a.ts", 1]])
  })

  test("a deleted file has no added lines to scan", () => {
    const diff = ["diff --git a/a.ts b/a.ts", "--- a/a.ts", "+++ /dev/null", "@@ -1 +0,0 @@", `-${secret}`, ""].join(
      "\n",
    )
    expect(scanDiff(diff)).toEqual([])
  })

  test("a file name with spaces keeps its name", () => {
    const diff = [
      "diff --git a/my file.ts b/my file.ts",
      "--- a/my file.ts\t",
      "+++ b/my file.ts\t",
      "@@ -0,0 +1 @@",
      `+v = "${secret}"`,
      "",
    ].join("\n")
    expect(scanDiff(diff).map((f) => f.file)).toEqual(["my file.ts"])
  })

  test("the fingerprint is file:line:rule", () => {
    const [finding] = scanDiff(diffOf("src/a.ts", ["x", `v = "${secret}"`], 10))
    expect(finding).toMatchObject({
      file: "src/a.ts",
      line: 11,
      rule: "github-pat",
      source: "builtin",
      fingerprint: "src/a.ts:11:github-pat",
    })
  })

  test("the same value twice on a line is one finding", () => {
    expect(rulesOf("a.ts", `v = "${secret}" w = "${secret}"`)).toEqual(["github-pat"])
  })

  test("findings keep diff order", () => {
    const other = PREFIXED["npm-token"]!
    const findings = scanDiff(diffOf("a.ts", [`a = ${other}`, "plain", `b = ${secret}`]))
    expect(findings.map((f) => [f.line, f.rule])).toEqual([
      [1, "npm-token"],
      [3, "github-pat"],
    ])
  })

  test("never returns a raw secret", () => {
    const random = randomish(32)
    const diff = diffOf("a.ts", [`v = "${secret}"`, `api_key = "${random}"`, `v = "${PREFIXED["private-key"]}"`])
    const findings = scanDiff(diff)
    expect(findings.length).toBe(3)
    const text = JSON.stringify(findings)
    for (const raw of [secret, random]) expect(text).not.toContain(raw)
    expect(findings[0]!.redacted).toBe(`${secret.slice(0, 3)}...${secret.slice(-3)} [${secret.length} chars]`)
  })
})
