import type { ToolSpec } from "./core"
import { commitCreate } from "./core/commit/create"
import { commitRead } from "./core/commit/read"
import { commitStage } from "./core/commit/stage"
import { repoRead } from "./core/repo/read"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [repoRead, commitRead, commitStage, commitCreate]
