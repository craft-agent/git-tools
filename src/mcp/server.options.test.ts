import { afterEach, describe, expect, test } from "bun:test"
import { NOTE_ID, NOTE_OPTION, noteSpec } from "../entry/options.testing"
import { parseSettings } from "../entry/settings"
import { call, connect, runCleanups, settings } from "./testing"

afterEach(runCleanups)

describe("tool options", () => {
  test("a call's context carries the options of the settings", async () => {
    const { client } = await connect([noteSpec], settings({ options: { [NOTE_OPTION]: "from settings" } }))
    expect((await call(client, NOTE_ID)).structuredContent).toEqual({ options: { [NOTE_OPTION]: "from settings" } })
  })

  test("a call without options gets an empty set", async () => {
    const { client } = await connect([noteSpec], settings())
    expect((await call(client, NOTE_ID)).structuredContent).toEqual({ options: {} })
  })

  test("the options come from the command line of the server", async () => {
    const profile = {
      name: "demo-tools",
      envPrefix: "DEMO",
      toolsets: { names: ["alpha"], defaults: ["alpha"] },
      options: { [NOTE_OPTION]: "text" } as const,
    }
    const entry = parseSettings(["--note-text", "from flag"], {}, profile)
    const { client } = await connect([noteSpec], entry)
    expect((await call(client, NOTE_ID)).structuredContent).toEqual({ options: { [NOTE_OPTION]: "from flag" } })
  })
})
