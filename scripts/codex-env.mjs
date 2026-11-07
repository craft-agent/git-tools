import { build } from "esbuild"
import { fileURLToPath } from "node:url"
import { format, resolveConfig } from "prettier"

/** The legacy manifest Codex loads the plugin from, which names the server relative to the plugin root. */
export const CODEX_MANIFEST = ".codex-plugin/plugin.json"

/** The absolute path to Codex's legacy manifest. */
export const CODEX_MANIFEST_PATH = fileURLToPath(new URL(`../${CODEX_MANIFEST}`, import.meta.url))

const ROOT = fileURLToPath(new URL("../", import.meta.url))

/** Updates the single MCP server's `env_vars` in Codex's manifest text and formats it. */
export async function renderCodexEnv(text, variables) {
  const doc = JSON.parse(text)
  const servers = Object.values(doc.mcpServers ?? {})
  if (servers.length !== 1) {
    throw new Error(`${CODEX_MANIFEST} needs exactly one server in \`mcpServers\`.`)
  }
  servers[0].env_vars = [...variables]
  const config = await resolveConfig(CODEX_MANIFEST_PATH)
  return format(JSON.stringify(doc, null, 2), { ...config, filepath: CODEX_MANIFEST_PATH })
}

/** Loads the forwarded environment variables defined in TypeScript through an in-memory esbuild bundle. */
export async function loadForwardedVariables() {
  const result = await build({
    stdin: {
      contents: 'export { forwardedVariables } from "./src/entry/settings"',
      resolveDir: ROOT,
      loader: "ts",
      sourcefile: "forwarded-variables.ts",
    },
    bundle: true,
    write: false,
    format: "esm",
    platform: "node",
    target: "node24",
    logLevel: "silent",
  })
  const base64 = Buffer.from(result.outputFiles[0].contents).toString("base64")
  const mod = await import(`data:text/javascript;base64,${base64}`)
  return mod.forwardedVariables()
}
