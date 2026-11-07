import type { ErrorCode, ErrorDetails, ToolError } from "../core"

/** The `error` object of a JSON error document: the code, the message, and `details` only when set. */
export function errorBody(
  code: ErrorCode,
  message: string,
  details?: Readonly<ErrorDetails>,
): { code: ErrorCode; message: string; details?: Readonly<ErrorDetails> } {
  return { code, message, ...(details !== undefined && { details }) }
}

/** A tool error as text: `<code>: <message>`, then `details` as JSON on a line of its own when set. */
export function errorText(error: ToolError): string {
  return `${error.code}: ${error.message}${error.details !== undefined ? `\n${JSON.stringify(error.details)}` : ""}`
}
