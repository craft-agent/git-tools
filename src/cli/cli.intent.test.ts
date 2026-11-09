import { describe, expect, test } from "bun:test"
import { EXIT_OK } from "./cli"
import { ADD_ID, ENGLISH_WORDS, INTENT, INTENT_ID, INTENT_TRANSLATIONS, cli, intentSpecs, json, specs } from "./testing"

const ARGS = '{"area":"north"}'
const all = [...specs, ...intentSpecs]

describe("list with an intent", () => {
  test("carries the intent of the tools that have one, and no key for the others", async () => {
    const run = await cli(["list", "--tools", INTENT_ID], "", { specs: all })
    expect(run.code).toBe(EXIT_OK)
    const listed: { id: string; intent?: string }[] = json(run)
    const intents = Object.fromEntries(listed.map((entry) => [entry.id, entry.intent]))
    expect(intents[INTENT_ID]).toBe(INTENT)
    expect(listed.filter((entry) => "intent" in entry).map((entry) => entry.id)).toEqual([INTENT_ID])
  })
})

describe("target with an intent", () => {
  const target = (id: string, flags: string[]) =>
    cli(["target", id, "--cwd", "/x", ...flags], ARGS, { specs: all, translations: INTENT_TRANSLATIONS })

  test("answers the intent beside the title, in English", async () => {
    const run = await target(INTENT_ID, [])
    expect(run.code).toBe(EXIT_OK)
    expect(json(run)).toEqual({ resources: ["north"], title: INTENT_ID, intent: INTENT, words: ENGLISH_WORDS })
  })

  test("translates the intent", async () => {
    const answer = json(await target(INTENT_ID, ["--language", "ja"]))
    expect(answer.intent).toBe("モノに触れようとしています")
    expect(answer.title).toBe(INTENT_ID)
  })

  test("leaves the intent out for a tool without one", async () => {
    expect("intent" in json(await target(ADD_ID, ["--language", "ja"]))).toBe(false)
  })
})
