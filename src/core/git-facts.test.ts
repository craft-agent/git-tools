import { describe, expect, test } from "bun:test"
import {
  branchFact,
  commitsFact,
  filesFact,
  forcePushFact,
  GIT_FACT_TRANSLATIONS,
  linesFact,
  newBranchFact,
} from "./git-facts"
import type { CallFact } from "./tool"
import { translator } from "./words"

describe("linesFact", () => {
  test("labels the fact Lines and keeps both counts as numbers", () => {
    expect(linesFact(3, 1)).toEqual({
      label: "Lines",
      value: { text: "{added} added, {removed} removed", values: { added: 3, removed: 1 } },
    })
    expect(linesFact(0, 0).value).toEqual({
      text: "{added} added, {removed} removed",
      values: { added: 0, removed: 0 },
    })
  })
})

describe("filesFact", () => {
  test("labels the fact Files and picks the English form for the count", () => {
    expect(filesFact(1)).toEqual({ label: "Files", value: { text: "{files} file", values: { files: 1 } } })
    expect(filesFact(3)).toEqual({ label: "Files", value: { text: "{files} files", values: { files: 3 } } })
  })
})

describe("commitsFact", () => {
  test("labels the fact Commits and picks the English form for the count", () => {
    expect(commitsFact(1)).toEqual({ label: "Commits", value: { text: "{commits} commit", values: { commits: 1 } } })
    expect(commitsFact(3)).toEqual({ label: "Commits", value: { text: "{commits} commits", values: { commits: 3 } } })
  })
})

describe("branchFact", () => {
  test("labels the fact Branch and keeps the name as a plain string", () => {
    expect(branchFact("feat/x")).toEqual({ label: "Branch", value: "feat/x" })
  })
})

describe("newBranchFact", () => {
  test("labels the fact New branches and keeps the name and the base as values of a template", () => {
    expect(newBranchFact("task/x", "origin/main")).toEqual({
      label: "New branches",
      value: { text: "{name} from {base}", values: { name: "task/x", base: "origin/main" } },
    })
  })
})

describe("forcePushFact", () => {
  test("labels the fact Push and says the push needs a force push", () => {
    expect(forcePushFact()).toEqual({ label: "Push", value: { text: "needs a force push" } })
  })
})

describe("GIT_FACT_TRANSLATIONS", () => {
  const ja = translator(GIT_FACT_TRANSLATIONS, "ja")
  const facts: CallFact[] = [
    forcePushFact(),
    linesFact(3, 1),
    filesFact(1),
    filesFact(2),
    commitsFact(1),
    commitsFact(2),
    branchFact("main"),
    newBranchFact("task/x", "origin/main"),
  ]
  const labels = [...new Set(facts.map((fact) => fact.label))]
  const templates = facts.flatMap((fact) => (typeof fact.value === "string" ? [] : [fact.value.text]))

  test("has exactly the labels and the value templates the facts write", () => {
    expect(Object.keys(GIT_FACT_TRANSLATIONS.ja!).sort()).toEqual([...labels, ...templates].sort())
  })

  test("translates the labels and keeps the placeholders of the templates", () => {
    expect(ja.word("Lines")).toBe("行数")
    expect(ja.word("Files")).toBe("ファイル数")
    expect(ja.word("Branch")).toBe("ブランチ")
    for (const text of templates) expect(ja.template(text)).toBe(GIT_FACT_TRANSLATIONS.ja![text]!)
  })
})
