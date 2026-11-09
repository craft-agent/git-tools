import { describe, expect, test } from "bun:test"
import {
  ADD_ID,
  ENGLISH_ADD,
  ENGLISH_INTENT,
  ENGLISH_INTENT_LABEL,
  INTENT_ID,
  INTENT_LABEL_ID,
  INTENT_TRANSLATIONS,
  JAPANESE_ADD,
  JAPANESE_INTENT,
  JAPANESE_INTENT_LABEL,
  PROFILE,
  TRANSLATIONS,
  fixtureSpecs,
  intentSpecs,
} from "./testing"
import type { V2Context, V2PermissionRequest, V2Tool } from "./types"
import { createV2Setup } from "./v2"

const translations = { ja: { ...TRANSLATIONS.ja, ...INTENT_TRANSLATIONS.ja } }

async function message(id: string, language?: string): Promise<string> {
  const asserts: V2PermissionRequest[] = []
  const tools = new Map<string, V2Tool>()
  const ctx: V2Context = {
    options: language === undefined ? {} : { language },
    session: { get: async () => ({ location: { directory: "/work/project" } }) },
    permission: {
      async assert(input) {
        asserts.push(input)
      },
    },
    tool: { transform: async (callback) => callback({ add: (tool) => tools.set(tool.name, tool) }) },
    skill: { transform: async () => {} },
  }
  await createV2Setup([...fixtureSpecs([]), ...intentSpecs([])], { env: {}, profile: PROFILE, translations })(ctx)
  await tools.get(id)!.execute({ area: "north" }, { sessionID: "ses_1", signal: new AbortController().signal })
  return String(asserts[0]?.metadata?.message)
}

describe("V2 permission prompt with an intent", () => {
  test("a tool with an intent and no describe opens with the intent", async () => {
    expect(await message(INTENT_ID)).toBe(ENGLISH_INTENT)
    expect(await message(INTENT_ID, "ja")).toBe(JAPANESE_INTENT)
  })

  test("a headline wins over the intent", async () => {
    expect(await message(INTENT_LABEL_ID)).toBe(ENGLISH_INTENT_LABEL)
    expect(await message(INTENT_LABEL_ID, "ja")).toBe(JAPANESE_INTENT_LABEL)
  })

  test("a tool without an intent opens with its title, as before", async () => {
    expect(await message(ADD_ID)).toBe(ENGLISH_ADD)
    expect(await message(ADD_ID, "ja")).toBe(JAPANESE_ADD)
  })
})
