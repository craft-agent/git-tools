/**
 * The manifests that carry the package's version in a top-level `version`
 * field, relative to the repository root. The `version-files` input of
 * `.github/workflows/release-publish.yml` lists the same paths, so the release
 * workflow bumps them with package.json; `scripts/manifests.mjs` checks them.
 */
export const VERSION_FILES = [
  ".codex-plugin/plugin.json",
  ".claude-plugin/plugin.json",
  ".antigravity-plugin/plugin.json",
  "plugin.yaml",
]
