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
import type { V1AskRequest, V1ToolContext } from "./types"
import { createV1Server } from "./v1"

const translations = { ja: { ...TRANSLATIONS.ja, ...INTENT_TRANSLATIONS.ja } }

async function message(id: string, language?: string): Promise<string> {
  const asks: V1AskRequest[] = []
  const context: V1ToolContext = {
    directory: "/work/project",
    worktree: "/work/project",
    abort: new AbortController().signal,
    async ask(request) {
      asks.push(request)
    },
  }
  const { tool } = await createV1Server([...fixtureSpecs([]), ...intentSpecs([])], {
    env: {},
    profile: PROFILE,
    translations,
  })({}, language === undefined ? {} : { language })
  await tool[id]!.execute({ area: "north" }, context)
  return String(asks[0]?.metadata.message)
}

describe("V1 permission prompt with an intent", () => {
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
