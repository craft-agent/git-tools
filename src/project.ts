/** What makes this package itself; a project made from the starter sets these once (the setup script does). */
export const PROJECT = {
  /** The plugin, MCP server and program name. */
  name: "git-tools",
  /** The command line the Hermes plugin calls. */
  cli: "git-tools-cli",
  /** Every tool ID starts with `<toolPrefix>_`. */
  toolPrefix: "git",
  /** Every setting's environment variable is `<envPrefix>_<SETTING>`. */
  envPrefix: "GIT_TOOLS",
  /** The toolsets, in the order `all` lists them. */
  toolsets: ["repo"] as readonly string[],
  /** The toolsets on when a setting names none. */
  defaultToolsets: ["repo"] as readonly string[],
  /** The environment variables the tools read besides the settings, which Codex forwards to the server after them. */
  toolVariables: [
    "LANGUAGE",
    "LC_CTYPE",
    "LC_MESSAGES",
    "XDG_CONFIG_HOME",
    "XDG_RUNTIME_DIR",
    "DBUS_SESSION_BUS_ADDRESS",
    "SSH_AUTH_SOCK",
    "GIT_SSH_COMMAND",
    "GNUPGHOME",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GH_ENTERPRISE_TOKEN",
    "GITHUB_ENTERPRISE_TOKEN",
    "GH_HOST",
    "GH_CONFIG_DIR",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "HOMEDRIVE",
    "HOMEPATH",
    "SystemRoot",
    "PATHEXT",
    "ComSpec",
    "TEMP",
    "TMP",
  ] as readonly string[],
} as const
