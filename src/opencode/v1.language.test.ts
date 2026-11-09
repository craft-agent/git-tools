import { describe, expect, test } from "bun:test"
import type { Translations } from "../core"
import {
  ADD_ID,
  ENGLISH_ADD,
  ENGLISH_LABEL,
  JAPANESE_ADD,
  JAPANESE_LABEL,
  LABEL_ID,
  PROFILE,
  TRANSLATIONS,
  fixtureSpecs,
} from "./testing"
import type { V1AskRequest, V1ToolContext } from "./types"
import { createV1Server } from "./v1"

async function asked(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = {},
  id: string = ADD_ID,
  translations: Translations = TRANSLATIONS,
): Promise<V1AskRequest> {
  const asks: V1AskRequest[] = []
  const context: V1ToolContext = {
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    async ask(request) {
      asks.push(request)
    },
  }
  const { tool } = await createV1Server(fixtureSpecs([]), { env, profile: PROFILE, translations })({}, options)
  await tool[id]!.execute({ area: "north" }, context)
  return asks[0]!
}

describe("V1 permission prompt in a language", () => {
  test("the language option draws the title, the plugin's words and the labels in Japanese", async () => {
    expect((await asked({ language: "ja" })).metadata.message).toBe(JAPANESE_ADD)
    expect((await asked({ language: "ja" }, {}, LABEL_ID)).metadata.message).toBe(JAPANESE_LABEL)
  })

  test("what the harness stores and matches is the same in every language", async () => {
    const english = await asked({})
    const japanese = await asked({ language: "ja-JP" })
    expect(japanese).toEqual({ ...english, metadata: { ...english.metadata, message: JAPANESE_ADD } })
  })

  test("the environment variable sets the language, and the option wins over it", async () => {
    expect((await asked({}, { DEMO_LANGUAGE: "ja" })).metadata.message).toBe(JAPANESE_ADD)
    expect((await asked({ language: "en" }, { DEMO_LANGUAGE: "ja" })).metadata.message).toBe(ENGLISH_ADD)
  })

  test("an unknown language, a blank one and none keep today's English", async () => {
    for (const options of [{ language: "fr" }, { language: "  " }, {}, undefined]) {
      expect((await asked(options)).metadata.message).toBe(ENGLISH_ADD)
    }
    expect((await asked({ language: "fr" }, {}, LABEL_ID)).metadata.message).toBe(ENGLISH_LABEL)
  })

  test("a package without translations still has the plugin's own words in Japanese", async () => {
    const request = await asked({ language: "ja" }, {}, ADD_ID, {})
    expect(request.metadata.message).toBe(`Title of ${ADD_ID}\n\n--- 詳細 ---\n\n対象: north`)
  })

  test("a language option that is not text is the invalid option error", async () => {
    await expect(asked({ language: 5 })).rejects.toThrow('Option "language" must be a language tag such as "ja".')
  })
})
