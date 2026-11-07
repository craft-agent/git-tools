# Releasing

Release Drafter keeps a draft release after each successful Tests run on
`main`. Publishing it ships every delivery: the plugins for the harnesses, the
npm package and the MCP Registry entry.

<!-- starter -->

The starter itself is `"private": true` in `package.json`, so its releases
tag the skeleton and publish nothing to npm or the MCP Registry. A project made
from it drops `private` (the setup script does) and ships as described below.

<!-- /starter -->

## Flow

Publish releases from the Actions tab: run **Publish release**
(`.github/workflows/release-publish.yml`) there. A release published on the
Releases page is not built and has no tag carrying `dist/`, so the `npm` and
`mcp-registry` jobs run only for the Actions-tab run, and nothing ships to
consumers from the Releases page.

1. **`release`** calls the shared release workflow of
   [repo-kit](https://github.com/craftsamo/repo-kit). It sets the draft's
   version in `package.json` and in the manifests listed in
   `scripts/version-files.mjs` with a commit on `main`, builds
   (`pnpm install --frozen-lockfile && pnpm run build`), and tags a release
   commit that adds the built `dist/` to that tree. `main` gets only the version
   commit, so it never holds `dist/`. Plugin installs and the Hermes plugin
   pin the tag or its commit.
2. **`package`** reads `private` from `package.json`; the two jobs below run
   only when it is not `true`.
3. **`npm`** checks out the tag and publishes the package with
   `npm publish --ignore-scripts`. It installs nothing, since the tag already
   carries `dist/`; it checks that npm is 11.5.1 or later, that `package.json`
   names the tag's version, and that the tarball holds `dist/mcp.js`,
   `dist/cli.js` and `dist/opencode.js`. It authenticates with npm trusted
   publishing, so no token is stored, and the package carries a provenance
   statement. A version npm already publishes is skipped, so a re-run reaches
   the registry job; one npm still holds as staged is waited for, up to five
   minutes, until `npm view` shows it.
4. **`mcp-registry`** runs after `npm`. It checks out the tag, writes
   `server.json` from `package.json` (`scripts/server-json.mjs`; the file is not
   committed), and publishes it with `mcp-publisher`, authenticating with the
   workflow's GitHub OIDC token.

If `npm` or `mcp-registry` fails, fix the cause and re-run the failed job.

## Versions

The version lives in `package.json` and, as a top-level `version`, in every file
of `VERSION_FILES` in `scripts/version-files.mjs`. The workflow's
`version-files` input lists the same paths, and a test keeps the two equal.
Nobody edits a version by hand: the release workflow bumps it, and
`pnpm run manifests` rewrites the manifests from `package.json`
(`pnpm run manifests:check` fails when one differs).

A tool ID change also changes `provides_tools` in `plugin.yaml`; run
`pnpm run build && pnpm run manifests` and commit the result.

## One-time setup

- **npm.** The package must exist before its settings do, so publish the first
  version by hand from its tag with
  `npm publish --access public --ignore-scripts --provenance=false`
  (`publishConfig.provenance` is true and a local publish cannot make
  provenance). Then, on npmjs.com, open the package's settings and add a
  trusted publisher: GitHub Actions, the repository's owner and name, workflow
  `release-publish.yml`. npm does not check the entry when it is saved, and
  expires it unless a publish succeeds within two days. Right after a manual
  publish, npm holds the version as staged while it validates it: `npm view`
  answers E404 and another publish is refused as staged. The release workflow
  then waits for `npm view` to show the version, so the job may be run at once;
  if npm still holds it after five minutes, the job fails and may be re-run.
- **MCP Registry.** Nothing beyond the workflow's OIDC token: the GitHub login
  proves the `io.github.<owner>/*` namespace, and `mcpName` in `package.json`
  proves that the npm package belongs to the entry.
- **Repository.** `repo-kit setup github` creates the release deploy key
  (`RELEASE_DEPLOY_KEY`) that lets the version commit past the protection of
  `main`, and allows the actions the workflows use. Run it again after a
  workflow starts using a new action. An organization must allow deploy keys in
  its repositories (member privileges); where it does not, the key is disabled
  and the `release` job fails when it pushes the version commit.

`mcp-publisher` is pinned to one release and verified against its Sigstore
bundle before it runs; raise `MCP_PUBLISHER_VERSION` in the workflow when a new
one is wanted.
