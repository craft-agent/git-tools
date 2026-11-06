import { STARTER } from "./identity.mjs"

/** OpenCode's project configuration, which the setup writes after the renames so they cannot reach it. */
export const OPENCODE_CONFIG = "opencode.jsonc"

/** The starter's repository, as an OpenCode reference names it. */
export const STARTER_REPOSITORY = `${STARTER.owner}/${STARTER.name}`

/**
 * The configuration a project made from the starter begins with: a reference to the starter, so an agent
 * working on the project can read the skeleton it was made from and later merges from.
 */
export function opencodeConfig() {
  const reference = {
    repository: STARTER_REPOSITORY,
    description:
      "The template this package was made from: its skeleton, conventions and setup, and later changes to merge from its default branch",
  }
  return `${JSON.stringify({ $schema: "https://opencode.ai/config.json", references: { starter: reference } }, null, 2)}\n`
}
