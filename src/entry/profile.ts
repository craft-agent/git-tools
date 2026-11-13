import { GRANTS_TOOLSET, type OptionSpec, type Toolsets } from "../core"
import { PROJECT } from "../project"

/** What an entry point takes from the package's identity: the prefix of its settings' environment variables, its toolsets and the types of its tool options, with their bounds. */
export type EntryProfile = {
  envPrefix: string
  toolsets: Toolsets
  options?: Readonly<Record<string, OptionSpec>>
}

/** The profile of this package, which every entry point uses unless a test supplies its own. */
export const PROJECT_PROFILE: EntryProfile = {
  envPrefix: PROJECT.envPrefix,
  toolsets: { names: [...PROJECT.toolsets, GRANTS_TOOLSET], defaults: PROJECT.defaultToolsets },
  options: PROJECT.options,
}
