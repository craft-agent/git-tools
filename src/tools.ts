import type { ToolSpec } from "./core"
import { exampleNoteCreate } from "./core/example/create"
import { exampleNoteRead } from "./core/example/read"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [exampleNoteRead, exampleNoteCreate]
