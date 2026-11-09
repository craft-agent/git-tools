import { describe, expect, test } from "bun:test"
import { FACT_TRANSLATIONS } from "./core/facts"
import { ALL_TRANSLATIONS } from "./words"

describe("ALL_TRANSLATIONS", () => {
  test("holds the shared fact words in Japanese", () => {
    expect(ALL_TRANSLATIONS.ja).toEqual({ ...FACT_TRANSLATIONS.ja })
    expect(ALL_TRANSLATIONS.ja!.Size).toBe("サイズ")
  })
})
