import { describe, expect, test } from "bun:test"
import { z } from "zod"
import { translator, type CallDescription, type ToolContext, type ToolSpec, type Translations } from "../core"
import { approvalPrompt, permissionDescription } from "./description"
import { ENGLISH_PROMPT_WORDS, PLUGIN_TRANSLATIONS, promptTranslator, promptWords } from "./words"

const CTX: ToolContext = { cwd: "/work", ownDir: "/own" }
const input = z.object({ name: z.string().default("x") })

const TABLE: Translations = {
  ja: {
    "Create the note {name}": "メモ用に {name} を作成する",
    "Open {name}": "{other} を開く",
    Size: "サイズ",
    "Note text": "メモの本文",
    Title: "題名",
  },
}
const ja = translator(TABLE, "ja")

function answering(answer: CallDescription) {
  type Describer = NonNullable<ToolSpec<typeof input>["describe"]>
  return { input, describe: (async () => answer) as unknown as Describer } as Pick<ToolSpec, "input" | "describe">
}

const NOTE: CallDescription = {
  headline: { text: "Create the note {name}", values: { name: "todo" } },
  facts: [{ label: "Size", value: "42 bytes" }],
  text: { label: "Note text", body: "Size" },
}

describe("permissionDescription in a language", () => {
  test("translates the headline template and the labels, never the values or the text", async () => {
    const result = await permissionDescription(answering(NOTE), {}, CTX, undefined, ja)
    expect(result).toEqual({
      headline: 'メモ用に "todo" を作成する',
      facts: [{ label: "サイズ", value: "42 bytes" }],
      text: { label: "メモの本文", body: "Size" },
    })
  })

  test("keeps a value that is a word of the table as the call's data", async () => {
    const description: CallDescription = {
      headline: { text: "Create the note {name}", values: { name: "Size" } },
      facts: [{ label: "Size", value: "Size" }],
    }
    const result = await permissionDescription(answering(description), {}, CTX, undefined, ja)
    expect(result).toEqual({ headline: 'メモ用に "Size" を作成する', facts: [{ label: "サイズ", value: "Size" }] })
  })

  test("falls back to the English template when the translation has other placeholders", async () => {
    const description: CallDescription = { headline: { text: "Open {name}", values: { name: "a" } }, facts: [] }
    const result = await permissionDescription(answering(description), {}, CTX, undefined, ja)
    expect(result?.headline).toBe('Open "a"')
  })

  test("keeps an untranslated word in English", async () => {
    const description: CallDescription = { facts: [{ label: "Kind", value: "note" }] }
    const result = await permissionDescription(answering(description), {}, CTX, undefined, ja)
    expect(result).toEqual({ facts: [{ label: "Kind", value: "note" }] })
  })

  test("keeps the English label when the translation is over the label budget", async () => {
    const long = translator({ ja: { Size: "長".repeat(41), "Note text": "長".repeat(41) } }, "ja")
    const result = await permissionDescription(answering(NOTE), {}, CTX, undefined, long)
    expect(result?.facts).toEqual([{ label: "Size", value: "42 bytes" }])
    expect(result?.text?.label).toBe("Note text")
  })

  test("marks hidden characters in a translation", async () => {
    const odd = translator({ ja: { Size: "サ\u202eイズ" } }, "ja")
    const result = await permissionDescription(answering(NOTE), {}, CTX, undefined, odd)
    expect(result?.facts[0]?.label).toBe("サ<U+202E>イズ")
  })

  test("is English for an unknown language and by default", async () => {
    const english = {
      headline: 'Create the note "todo"',
      facts: [{ label: "Size", value: "42 bytes" }],
      text: { label: "Note text", body: "Size" },
    }
    expect(await permissionDescription(answering(NOTE), {}, CTX, undefined, translator(TABLE, "fr"))).toEqual(english)
    expect(await permissionDescription(answering(NOTE), {}, CTX)).toEqual(english)
  })
})

describe("approvalPrompt in a language", () => {
  test("draws the plugin's own words and the title in Japanese", () => {
    const t = promptTranslator(TABLE, "ja")
    const description = { facts: [{ label: "サイズ", value: "42 bytes" }] }
    expect(approvalPrompt(t.word("Title"), ["/a"], description, promptWords(t))).toBe(
      "題名\n\n--- 詳細 ---\n\n対象: /a\nサイズ: 42 bytes",
    )
  })

  test("marks hidden characters in the title", () => {
    expect(approvalPrompt("Ti\u202etle", ["*"], undefined)).toBe("Ti<U+202E>tle")
  })
})

describe("promptWords", () => {
  test("are the English words through ENGLISH or a language without a table", () => {
    expect(promptWords(translator({}, undefined))).toEqual(ENGLISH_PROMPT_WORDS)
    expect(promptWords(promptTranslator({}, "fr"))).toEqual(ENGLISH_PROMPT_WORDS)
  })

  test("are Japanese through the plugin's table", () => {
    expect(promptWords(promptTranslator({}, "ja-JP"))).toEqual({
      details: "詳細",
      target: "対象",
      more: "（ほか {count} 件）",
    })
  })

  test("marks hidden characters", () => {
    const odd = translator({ ja: { Details: "詳\u202e細" } }, "ja")
    expect(promptWords(odd).details).toBe("詳<U+202E>細")
  })
})

describe("promptTranslator", () => {
  test("lets the package's words win over the plugin's", () => {
    const t = promptTranslator({ ja: { Details: "明細" } }, "ja")
    expect(t.word("Details")).toBe("明細")
    expect(t.word("Target")).toBe(PLUGIN_TRANSLATIONS.ja!.Target!)
  })

  test("adds the plugin's words to a package with no table for the language", () => {
    expect(promptTranslator({ fr: { Details: "Détails" } }, "ja").word("Details")).toBe("詳細")
  })
})
