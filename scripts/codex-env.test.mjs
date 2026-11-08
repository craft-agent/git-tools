import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { check, resolveConfig } from "prettier"
import { forwardedVariables } from "../src/entry/settings"
import { CODEX_MANIFEST_PATH, importModuleText, loadForwardedVariables, renderCodexEnv } from "./codex-env.mjs"

const realManifest = readFileSync(CODEX_MANIFEST_PATH, "utf8")

describe("Codex environment variables", () => {
  test("renders the real manifest unchanged with forwardedVariables()", async () => {
    const rendered = await renderCodexEnv(realManifest, forwardedVariables())
    expect(rendered).toBe(realManifest)
  })

  test("appends variables without changing other fields and passes prettier", async () => {
    const variables = [...forwardedVariables(), "XDG_STATE_HOME"]
    const result = await renderCodexEnv(realManifest, variables)

    const parsed = JSON.parse(result)
    const [server] = Object.values(parsed.mcpServers)
    expect(server.env_vars.at(-1)).toBe("XDG_STATE_HOME")

    const original = JSON.parse(realManifest)
    const [originalServer] = Object.values(original.mcpServers)
    delete server.env_vars
    delete originalServer.env_vars
    expect(parsed).toEqual(original)

    const config = await resolveConfig(CODEX_MANIFEST_PATH)
    expect(await check(result, { ...config, filepath: CODEX_MANIFEST_PATH })).toBe(true)
  })

  test("throws when the manifest has zero or two servers", async () => {
    await expect(renderCodexEnv(JSON.stringify({ mcpServers: {} }), forwardedVariables())).rejects.toThrow()
    await expect(
      renderCodexEnv(JSON.stringify({ mcpServers: { first: {}, second: {} } }), forwardedVariables()),
    ).rejects.toThrow()
  })

  test("loadForwardedVariables resolves to the same array as forwardedVariables()", async () => {
    expect(await loadForwardedVariables()).toEqual(forwardedVariables())
  })

  test("importModuleText imports a module far longer than a file name may be", async () => {
    const padding = "x".repeat(400_000)
    const mod = await importModuleText(`export const padding = "${padding}"\nexport const answer = () => 42\n`)
    expect(mod.answer()).toBe(42)
    expect(mod.padding).toHaveLength(padding.length)
  })
})
