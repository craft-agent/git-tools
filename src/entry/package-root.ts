import { dirname } from "node:path"
import { fileURLToPath } from "node:url"

/**
 * The package's root directory, given the URL of a bundled entry point. Every
 * bundle sits in the package's `dist/`, so the root is the directory above it.
 * It is the `ownDir` an entry point hands to the tools: where they are
 * installed, never the caller's working tree.
 */
export function packageRoot(bundleUrl: URL | string): string {
  return dirname(dirname(fileURLToPath(bundleUrl)))
}
