import { describe, expect, test } from "bun:test"
import { MAX_HEADLINE_LENGTH } from "./describe"
import { ENGLISH, languageOf, mergeTranslations, translator, type Translations } from "./words"

const TABLES: Translations = {
  ja: {
    Details: "詳細",
    Blank: "  ",
    Long: "とても長い言葉です",
    "Create the note {name}": "ノート {name} を作る",
    "Copy {from} to {to}": "{to} へ {from} をコピーする",
    "Close the window": "ウィンドウを閉じる",
    "Open {name}": "開く",
    "Save {name}": "{name} を {where} に保存する",
    "Rename {name}": "{title} の名前を変える",
    "Delete {name}": "{name} を削除する {",
    "Move {name}": `${"長".repeat(MAX_HEADLINE_LENGTH)} {name}`,
    "Print {name}": "   ",
    "Show the {name": "{name} を見せる",
    Quit: "終了{}",
  },
  zh: { Details: "详情" },
}

const WITH_HANT: Translations = { ...TABLES, "zh-hant": { Details: "詳情" } }

describe("languageOf", () => {
  test("matches a table by its tag, case and separator aside", () => {
    for (const tag of ["ja", "JA", "ja-JP", "ja_JP", " ja ", "Ja_jp"]) {
      expect(languageOf(tag, TABLES)).toBe("ja")
    }
  })

  test("prefers the whole tag, else falls to the first subtag", () => {
    expect(languageOf("zh-Hant", WITH_HANT)).toBe("zh-hant")
    expect(languageOf("zh_Hant", WITH_HANT)).toBe("zh-hant")
    expect(languageOf("zh-Hant", TABLES)).toBe("zh")
    expect(languageOf("zh-Hans-CN", WITH_HANT)).toBe("zh")
  })

  test("is undefined for English, an unknown language and a blank or missing tag", () => {
    for (const tag of ["en", "en-US", "fr", "", "   ", undefined]) {
      expect(languageOf(tag, TABLES)).toBeUndefined()
    }
  })

  test("never resolves an inherited key", () => {
    for (const tag of ["__proto__", "constructor", "toString", "hasOwnProperty", "constructor-x"]) {
      expect(languageOf(tag, TABLES)).toBeUndefined()
    }
  })
})

describe("mergeTranslations", () => {
  test("joins the words of each language", () => {
    const merged = mergeTranslations({ ja: { A: "あ" }, zh: { A: "啊" } }, { ja: { B: "い" }, fr: { A: "a" } })
    expect(merged).toEqual({ ja: { A: "あ", B: "い" }, zh: { A: "啊" }, fr: { A: "a" } })
  })

  test("lets the first table win a shared word", () => {
    const merged = mergeTranslations({ ja: { A: "first" } }, { ja: { A: "second", B: "b" } })
    expect(merged).toEqual({ ja: { A: "first", B: "b" } })
  })

  test("changes no input", () => {
    const first: Translations = { ja: { A: "あ" } }
    const second: Translations = { ja: { B: "い" } }
    const merged = mergeTranslations(first, second)
    expect(first).toEqual({ ja: { A: "あ" } })
    expect(second).toEqual({ ja: { B: "い" } })
    expect(merged.ja).not.toBe(first.ja)
  })

  test("gives an empty table for no tables", () => {
    expect(mergeTranslations()).toEqual({})
  })

  test("keeps a __proto__ key as data", () => {
    const table = JSON.parse('{"ja":{"__proto__":"x"}}') as Translations
    const merged = mergeTranslations(table)
    expect(Object.hasOwn(merged.ja as object, "__proto__")).toBe(true)
    expect(Object.getPrototypeOf(merged.ja)).toBe(Object.prototype)
  })
})

describe("translator.word", () => {
  const ja = translator(TABLES, "ja-JP")

  test("gives the translation of a known word", () => {
    expect(ja.word("Details")).toBe("詳細")
  })

  test("keeps a missing or blank translation in English", () => {
    expect(ja.word("Target")).toBe("Target")
    expect(ja.word("Blank")).toBe("Blank")
  })

  test("keeps a translation that is not a string in English", () => {
    const odd = translator({ ja: { Count: 3, Gone: null } } as unknown as Translations, "ja")
    expect(odd.word("Count")).toBe("Count")
    expect(odd.word("Gone")).toBe("Gone")
  })

  test("never cuts a translation over the limit", () => {
    expect(ja.word("Long", 9)).toBe("とても長い言葉です")
    expect(ja.word("Long", 8)).toBe("Long")
    expect(ja.word("Long", 0)).toBe("Long")
  })

  test("counts code points, not UTF-16 units", () => {
    const emoji = translator({ ja: { Smile: "😀😀" } }, "ja")
    expect(emoji.word("Smile", 2)).toBe("😀😀")
    expect(emoji.word("Smile", 1)).toBe("Smile")
  })

  test("never resolves an inherited key", () => {
    for (const english of ["constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(ja.word(english)).toBe(english)
    }
  })

  test("falls to the first subtag table", () => {
    expect(translator(WITH_HANT, "zh-Hans").word("Details")).toBe("详情")
    expect(translator(WITH_HANT, "zh-Hant").word("Details")).toBe("詳情")
  })
})

describe("translator.template", () => {
  const ja = translator(TABLES, "ja")

  test("gives a translation with the same placeholders", () => {
    expect(ja.template("Create the note {name}")).toBe("ノート {name} を作る")
  })

  test("allows the placeholders in another order", () => {
    expect(ja.template("Copy {from} to {to}")).toBe("{to} へ {from} をコピーする")
  })

  test("allows a template with no placeholder", () => {
    expect(ja.template("Close the window")).toBe("ウィンドウを閉じる")
  })

  test("keeps English when a placeholder is missing, extra or renamed", () => {
    expect(ja.template("Open {name}")).toBe("Open {name}")
    expect(ja.template("Save {name}")).toBe("Save {name}")
    expect(ja.template("Rename {name}")).toBe("Rename {name}")
  })

  test("keeps English when a brace is stray", () => {
    expect(ja.template("Delete {name}")).toBe("Delete {name}")
    expect(ja.template("Quit")).toBe("Quit")
  })

  test("keeps English when the translation is too long or blank", () => {
    expect(ja.template("Move {name}")).toBe("Move {name}")
    expect(ja.template("Print {name}")).toBe("Print {name}")
    expect(ja.template("Missing {name}")).toBe("Missing {name}")
  })

  test("takes the limit given in place of the headline budget", () => {
    const move = TABLES.ja!["Move {name}"]!
    const length = Array.from(move).length
    expect(length).toBeGreaterThan(MAX_HEADLINE_LENGTH)
    expect(ja.template("Move {name}")).toBe("Move {name}")
    expect(ja.template("Move {name}", length)).toBe(move)
    expect(ja.template("Move {name}", length - 1)).toBe("Move {name}")
    expect(ja.template("Create the note {name}", 5)).toBe("Create the note {name}")
  })

  test("keeps a malformed English template", () => {
    expect(ja.template("Show the {name")).toBe("Show the {name")
  })

  test("never resolves an inherited key", () => {
    for (const english of ["constructor", "__proto__", "toString"]) {
      expect(ja.template(english)).toBe(english)
    }
  })
})

describe("ENGLISH", () => {
  test("keeps every word and template", () => {
    expect(ENGLISH.word("Details", 3)).toBe("Details")
    expect(ENGLISH.template("Create the note {name}")).toBe("Create the note {name}")
  })

  test("is what a language without a table gets", () => {
    expect(translator(TABLES, "fr")).toBe(ENGLISH)
    expect(translator(TABLES, undefined)).toBe(ENGLISH)
    expect(translator(TABLES, "")).toBe(ENGLISH)
  })
})
