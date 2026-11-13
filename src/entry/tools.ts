import { grantTools, type ToolSpec } from "../core"
import { PROJECT } from "../project"
import { ALL_TOOLS } from "../tools"

/** Every tool an entry point registers: the package's own and the grant tools for them. */
export const PACKAGE_TOOLS: ToolSpec[] = [...ALL_TOOLS, ...grantTools(ALL_TOOLS, PROJECT.toolPrefix)]
