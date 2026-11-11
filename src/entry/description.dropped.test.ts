import { describe, expect, test } from "bun:test"
import { MAX_FACTS, translator, type CallDescription } from "../core"
import { approvalPrompt, shownDescription, type ShownDescription } from "./description"
import { factsLeftOut, promptTranslator, promptWords, ENGLISH_PROMPT_WORDS } from "./words"

const english = translator({}, undefined)

/** A description of `count` facts named `f1`, `f2`, … with the value `v`. */
function withFacts(count: number): CallDescription {
  return { facts: Array.from({ length: count }, (_, index) => ({ label: `f${index + 1}`, value: "v" })) }
}

describe("shownDescription dropped", () => {
  test("a description of at most eight facts has no dropped key", () => {
    for (const count of [0, 1, MAX_FACTS]) {
      expect(shownDescription(withFacts(count), english)).not.toHaveProperty("dropped")
    }
  })

  test("counts the facts past the eighth and keeps the first eight", () => {
    const shown = shownDescription(withFacts(MAX_FACTS + 2), english)
    expect(shown.dropped).toBe(2)
    expect(shown.facts.map(({ label }) => label)).toEqual(["f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8"])
    expect(shownDescription(withFacts(MAX_FACTS + 1), english).dropped).toBe(1)
  })
})

describe("approvalPrompt dropped", () => {
  const prompt = (description: ShownDescription, words = ENGLISH_PROMPT_WORDS) =>
    approvalPrompt("Create a thing", ["a.txt"], description, words)

  test("ends the Details section with the notice of the dropped facts", () => {
    const shown = shownDescription(withFacts(MAX_FACTS + 3), english)
    const facts = shown.facts.map(({ label }) => `${label}: v`)
    expect(prompt(shown)).toBe(
      ["Create a thing", "", "--- Details ---", "", "Target: a.txt", ...facts, "(+3 more)"].join("\n"),
    )
  })

  test("the notice comes before the text", () => {
    const shown: ShownDescription = {
      facts: [{ label: "A", value: "b" }],
      dropped: 1,
      text: { label: "Note", body: "t" },
    }
    expect(prompt(shown)).toBe(
      [
        "Create a thing",
        "",
        "--- Details ---",
        "",
        "Target: a.txt",
        "A: b",
        "(+1 more)",
        "",
        "--- Note ---",
        "",
        "t",
      ].join("\n"),
    )
  })

  test("without dropped facts there is no notice", () => {
    expect(prompt(shownDescription(withFacts(MAX_FACTS), english))).not.toContain("more)")
  })

  test("speaks the prompt language", () => {
    const words = promptWords(promptTranslator({}, "ja"))
    expect(prompt({ facts: [{ label: "A", value: "b" }], dropped: 4 }, words)).toEndWith("A: b\n（ほか 4 件）")
  })

  test("factsLeftOut fills the count as written", () => {
    expect(factsLeftOut(12345, ENGLISH_PROMPT_WORDS)).toBe("(+12345 more)")
  })
})
