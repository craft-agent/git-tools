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
import type { V2Context, V2PermissionRequest, V2Tool } from "./types"
import { createV2Setup } from "./v2"

const SESSION_ID = "ses_1"

async function asserted(
  options: Record<string, unknown> | undefined,
  env: Record<string, string | undefined> = {},
  id: string = ADD_ID,
  translations: Translations = TRANSLATIONS,
): Promise<V2PermissionRequest> {
  const asserts: V2PermissionRequest[] = []
  const tools = new Map<string, V2Tool>()
  const ctx: V2Context = {
    options,
    session: { get: async () => ({ location: { directory: "/work/project" } }) },
    permission: {
      async assert(input) {
        asserts.push(input)
      },
    },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async () => {} },
  }
  await createV2Setup(fixtureSpecs([]), { env, profile: PROFILE, translations })(ctx)
  await tools.get(id)!.execute({ area: "north" }, { sessionID: SESSION_ID, signal: new AbortController().signal })
  return asserts[0]!
}

describe("V2 permission prompt in a language", () => {
  test("the language option draws the title, the plugin's words and the labels in Japanese", async () => {
    expect((await asserted({ language: "ja" })).metadata?.message).toBe(JAPANESE_ADD)
    expect((await asserted({ language: "ja" }, {}, LABEL_ID)).metadata?.message).toBe(JAPANESE_LABEL)
  })

  test("what the harness stores and matches is the same in every language", async () => {
    const english = await asserted({})
    const japanese = await asserted({ language: "ja_JP" })
    expect(japanese).toEqual({ ...english, metadata: { ...english.metadata, message: JAPANESE_ADD } })
  })

  test("the environment variable sets the language, and the option wins over it", async () => {
    expect((await asserted({}, { DEMO_LANGUAGE: "ja" })).metadata?.message).toBe(JAPANESE_ADD)
    expect((await asserted({ language: "en" }, { DEMO_LANGUAGE: "ja" })).metadata?.message).toBe(ENGLISH_ADD)
  })

  test("an unknown language, a blank one and none keep today's English", async () => {
    for (const options of [{ language: "fr" }, { language: "  " }, {}, undefined]) {
      expect((await asserted(options)).metadata?.message).toBe(ENGLISH_ADD)
    }
    expect((await asserted({ language: "fr" }, {}, LABEL_ID)).metadata?.message).toBe(ENGLISH_LABEL)
  })

  test("a package without translations still has the plugin's own words in Japanese", async () => {
    const request = await asserted({ language: "ja" }, {}, ADD_ID, {})
    expect(request.metadata?.message).toBe(`Title of ${ADD_ID}\n\n--- 詳細 ---\n\n対象: north`)
  })

  test("a language option that is not text is the invalid option error", async () => {
    await expect(asserted({ language: 5 })).rejects.toThrow('Option "language" must be a language tag such as "ja".')
  })
})
