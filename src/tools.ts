import type { ToolSpec } from "./core"
import { commitAmend } from "./core/commit/amend"
import { commitCreate } from "./core/commit/create"
import { commitRead } from "./core/commit/read"
import { commitStage } from "./core/commit/stage"
import { commitVerify } from "./core/commit/verify"
import { pushRead } from "./core/push/read"
import { pushSend } from "./core/push/send"
import { rebaseRead } from "./core/rebase/read"
import { rebaseResume } from "./core/rebase/resume"
import { rebaseSplit } from "./core/rebase/split"
import { rebaseStart } from "./core/rebase/start"
import { repoRead } from "./core/repo/read"
import { worktreeAdd } from "./core/worktree/add"
import { worktreeRead } from "./core/worktree/read"
import { worktreeRemove } from "./core/worktree/remove"

/** Every tool spec of the package; entry points register their tools from this list. */
export const ALL_TOOLS: ToolSpec[] = [
  repoRead,
  commitRead,
  commitStage,
  commitCreate,
  commitAmend,
  commitVerify,
  rebaseRead,
  rebaseStart,
  rebaseResume,
  rebaseSplit,
  worktreeRead,
  worktreeAdd,
  worktreeRemove,
  pushRead,
  pushSend,
]
