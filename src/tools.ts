import type { ToolSpec } from "./core"
import { repoRead } from "./core/repo/read"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [repoRead]
