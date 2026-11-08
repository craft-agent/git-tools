import { build } from "esbuild"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
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

/**
 * Imports an ES module from its source text. The text goes to a temporary
 * file, not a `data:` URL: Bun on Linux resolves a `data:` URL as a file name
 * and fails with NameTooLong once a package's bundle outgrows the starter's.
 */
export async function importModuleText(text) {
  const dir = await mkdtemp(join(tmpdir(), "codex-env-"))
  try {
    const file = join(dir, "module.mjs")
    await writeFile(file, text)
    return await import(pathToFileURL(file).href)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

/** Loads the forwarded environment variables defined in TypeScript through an esbuild bundle. */
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
  const mod = await importModuleText(result.outputFiles[0].text)
  return mod.forwardedVariables()
}
