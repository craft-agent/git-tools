/** The codes a caller can branch on; `docs/conventions.md` says when each applies. */
export type ErrorCode =
  | "not_found"
  | "forbidden"
  | "invalid_argument"
  | "stale"
  | "unauthenticated"
  | "rate_limited"
  | "declined"
  | "upstream_error"
  | "internal_error"

/** The error every tool throws for a failure a caller can act on. */
export class ToolError extends Error {
  readonly code: ErrorCode

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = "ToolError"
    this.code = code
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError
}

/** Whether an error is a cancellation, which is never a tool failure to report or record. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}
