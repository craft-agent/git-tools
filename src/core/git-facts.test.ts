import { describe, expect, test } from "bun:test"
import { filesFact, GIT_FACT_TRANSLATIONS, linesFact } from "./git-facts"
import type { CallFact, CallValue } from "./tool"
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

describe("GIT_FACT_TRANSLATIONS", () => {
  const ja = translator(GIT_FACT_TRANSLATIONS, "ja")
  const facts: CallFact[] = [linesFact(3, 1), filesFact(1), filesFact(2)]
  const labels = [...new Set(facts.map((fact) => fact.label))]
  const templates = facts.map((fact) => (fact.value as CallValue).text)

  test("has exactly the labels and the value templates the facts write", () => {
    expect(Object.keys(GIT_FACT_TRANSLATIONS.ja!).sort()).toEqual([...labels, ...templates].sort())
  })

  test("translates the labels and keeps the placeholders of the templates", () => {
    expect(ja.word("Lines")).toBe("行数")
    expect(ja.word("Files")).toBe("ファイル数")
    for (const text of templates) expect(ja.template(text)).toBe(GIT_FACT_TRANSLATIONS.ja![text]!)
  })
})
