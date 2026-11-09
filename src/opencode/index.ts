import { packageRoot } from "../entry/package-root"
import { PROJECT } from "../project"
import { ALL_TOOLS } from "../tools"
import { ALL_TRANSLATIONS } from "../words"
import { createV1Server } from "./v1"
import { createV2Setup } from "./v2"
import type { OpenCodePlugin } from "./types"

/** The skills sit in the package root, one level above the built `dist/opencode.js`. */
const SKILLS_DIR = new URL("../skills/", import.meta.url)

/** The package root, which is where the plugin is installed and never the working tree of a call. */
const OWN_DIR = packageRoot(import.meta.url)

/** The OpenCode plugin: V2 reads `id` and `setup`, V1 reads `server`. */
const plugin: OpenCodePlugin = {
  id: PROJECT.name,
  setup: createV2Setup(ALL_TOOLS, { skillsDir: SKILLS_DIR, ownDir: OWN_DIR, translations: ALL_TRANSLATIONS }),
  server: createV1Server(ALL_TOOLS, { ownDir: OWN_DIR, translations: ALL_TRANSLATIONS }),
}

export default plugin
