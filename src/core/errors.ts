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

/** A value that JSON can carry. */
export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue }

/** The structured part of an error a caller needs to fix its cause: a JSON object with snake_case keys. */
export type ErrorDetails = { [key: string]: JsonValue }

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    Object.freeze(value)
    for (const child of Object.values(value)) {
      deepFreeze(child)
    }
  }
  return value
}

/** The error every tool throws for a failure a caller can act on. */
export class ToolError extends Error {
  readonly code: ErrorCode
  declare readonly details?: Readonly<ErrorDetails>

  constructor(code: ErrorCode, message: string, options?: { cause?: unknown; details?: ErrorDetails }) {
    super(message, options && "cause" in options ? { cause: options.cause } : undefined)
    this.name = "ToolError"
    this.code = code
    if (options?.details !== undefined) {
      this.details = deepFreeze(JSON.parse(JSON.stringify(options.details)))
    }
  }
}

export function isToolError(error: unknown): error is ToolError {
  return error instanceof ToolError
}

/** Whether an error is a cancellation, which is never a tool failure to report or record. */
export function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError"
}
