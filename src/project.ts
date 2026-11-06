/** What makes this package itself; a project made from the starter sets these once (the setup script does). */
export const PROJECT = {
  /** The plugin, MCP server and program name. */
  name: "agent-tool-starter",
  /** The command line the Hermes plugin calls. */
  cli: "agent-tool-starter-cli",
  /** Every tool ID starts with `<toolPrefix>_`. */
  toolPrefix: "example",
  /** Every setting's environment variable is `<envPrefix>_<SETTING>`. */
  envPrefix: "AGENT_TOOL_STARTER",
  /** The toolsets, in the order `all` lists them. */
  toolsets: ["notes"] as readonly string[],
  /** The toolsets on when a setting names none. */
  defaultToolsets: ["notes"] as readonly string[],
} as const
