import { describe, expect, test } from "bun:test"
import {
  MAX_FACTS,
  MAX_TEXT_LENGTH,
  MAX_VALUE_LENGTH,
  translator,
  type CallDescription,
  type Translations,
} from "../core"
import { approvalPrompt, shownDescription, type ShownDescription } from "./description"
import { charactersLeftOut, promptTranslator, promptWords, ENGLISH_PROMPT_WORDS } from "./words"

const english = translator({}, undefined)
const TABLE: Translations = { ja: { "{name} bytes": "{name} バイト" } }

/** The shown text of a text body of `length` characters. */
function shownText(length: number) {
  return shownDescription({ facts: [], text: { label: "Body", body: "a".repeat(length) } }, english).text
}

/** The shown facts of one fact with `value`. */
function shownFacts(value: CallDescription["facts"][number]["value"], t = english) {
  return shownDescription({ facts: [{ label: "Name", value }] }, t).facts
}

describe("shownDescription omitted", () => {
  test("a text within its budget has no omitted key", () => {
    expect(shownText(MAX_TEXT_LENGTH)).toEqual({ label: "Body", body: "a".repeat(MAX_TEXT_LENGTH) })
    expect(shownText(MAX_TEXT_LENGTH)).not.toHaveProperty("omitted")
  })

  test("counts the code points a cut text leaves out", () => {
    expect(shownText(MAX_TEXT_LENGTH + 1)?.omitted).toBe(2)
    expect(shownText(MAX_TEXT_LENGTH + 500)?.omitted).toBe(501)
    expect(Array.from(shownText(MAX_TEXT_LENGTH + 500)?.body ?? "")).toHaveLength(MAX_TEXT_LENGTH)
  })

  test("counts astral characters of a text as one", () => {
    const body = "😀".repeat(MAX_TEXT_LENGTH + 1)
    expect(shownDescription({ facts: [], text: { label: "Body", body } }, english).text?.omitted).toBe(2)
  })

  test("a string value within its budget has no omitted key", () => {
    const [fact] = shownFacts("a".repeat(MAX_VALUE_LENGTH))
    expect(fact).toEqual({ label: "Name", value: "a".repeat(MAX_VALUE_LENGTH) })
    expect(fact).not.toHaveProperty("omitted")
  })

  test("counts the code points a cut string value leaves out", () => {
    const [fact] = shownFacts("a".repeat(MAX_VALUE_LENGTH + 1))
    expect(fact?.omitted).toBe(2)
    expect(fact?.value).toBe(`${"a".repeat(MAX_VALUE_LENGTH - 1)}…`)
  })

  test("counts a template value on its filled form", () => {
    const [fact] = shownFacts({ text: "{name} bytes", values: { name: "x".repeat(300) } })
    expect(fact?.omitted).toBe(300 + " bytes".length - (MAX_VALUE_LENGTH - 1))
    expect(Array.from(fact?.value ?? "")).toHaveLength(MAX_VALUE_LENGTH)
  })

  test("a template value whose filled form fits has no omitted key", () => {
    const [fact] = shownFacts({
      text: "{name} bytes",
      values: { name: "x".repeat(MAX_VALUE_LENGTH - " bytes".length) },
    })
    expect(fact).not.toHaveProperty("omitted")
  })

  test("counts a translated template value on its translated filled form", () => {
    const [fact] = shownFacts({ text: "{name} bytes", values: { name: "x".repeat(250) } }, translator(TABLE, "ja"))
    expect(fact?.omitted).toBe(250 + " バイト".length - (MAX_VALUE_LENGTH - 1))
    expect(fact?.value.endsWith("…")).toBe(true)
  })

  test("counts each fact's own value among the kept facts", () => {
    const facts = Array.from({ length: MAX_FACTS + 1 }, (_, index) => ({
      label: `Fact ${index}`,
      value: index === 2 ? "a".repeat(MAX_VALUE_LENGTH + 10) : "short",
    }))
    const shown = shownDescription({ facts }, english).facts
    expect(shown).toHaveLength(MAX_FACTS)
    expect(shown.map((fact) => fact.omitted)).toEqual([
      undefined,
      undefined,
      11,
      ...Array(MAX_FACTS - 3).fill(undefined),
    ])
  })
})

describe("approvalPrompt notices", () => {
  const cutText: ShownDescription = {
    facts: [],
    text: { label: "Body", body: "abc…", omitted: 501 },
  }

  test("puts the notice on a line after a cut text", () => {
    expect(approvalPrompt("Title", ["*"], cutText)).toBe("Title\n\n--- Body ---\n\nabc…\n(+501 more characters)")
  })

  test("puts the notice after a cut value on its line", () => {
    const description: ShownDescription = {
      facts: [
        { label: "Name", value: "abc…", omitted: 7 },
        { label: "Size", value: "42" },
      ],
    }
    expect(approvalPrompt("Title", ["/a"], description)).toBe(
      "Title\n\n--- Details ---\n\nTarget: /a\nName: abc… (+7 more characters)\nSize: 42",
    )
  })

  test("leaves a text and a value that were not cut without a notice", () => {
    const description: ShownDescription = {
      facts: [{ label: "Name", value: "abc" }],
      text: { label: "Body", body: "x" },
    }
    expect(approvalPrompt("Title", ["*"], description)).toBe(
      "Title\n\n--- Details ---\n\nName: abc\n\n--- Body ---\n\nx",
    )
  })

  test("uses the singular for one character", () => {
    expect(approvalPrompt("Title", ["*"], { facts: [], text: { label: "Body", body: "a…", omitted: 1 } })).toBe(
      "Title\n\n--- Body ---\n\na…\n(+1 more character)",
    )
    expect(approvalPrompt("Title", ["*"], { facts: [{ label: "Name", value: "a…", omitted: 1 }] })).toContain(
      "Name: a… (+1 more character)",
    )
  })

  test("draws the notice in the prompt language", () => {
    const t = promptTranslator({}, "ja")
    expect(approvalPrompt("Title", ["*"], cutText, promptWords(t))).toBe(
      "Title\n\n--- Body ---\n\nabc…\n（ほか 501 文字）",
    )
  })

  test("end to end: a text of 2001 characters is followed by a notice of 2", () => {
    const description = shownDescription(
      { facts: [], text: { label: "Body", body: "a".repeat(MAX_TEXT_LENGTH + 1) } },
      english,
    )
    expect(approvalPrompt("Title", ["*"], description).endsWith("…\n(+2 more characters)")).toBe(true)
  })
})

describe("charactersLeftOut", () => {
  test("takes the singular for one and the plural for any other count", () => {
    expect(charactersLeftOut(1, ENGLISH_PROMPT_WORDS)).toBe("(+1 more character)")
    expect(charactersLeftOut(2, ENGLISH_PROMPT_WORDS)).toBe("(+2 more characters)")
  })

  test("writes the number without digit grouping", () => {
    expect(charactersLeftOut(12345, ENGLISH_PROMPT_WORDS)).toBe("(+12345 more characters)")
  })
})
