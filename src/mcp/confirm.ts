import type { Server } from "@modelcontextprotocol/sdk/server/index.js"
import type { ConfirmRequest, ToolContext } from "../core"

/** Whether the client can show a form-mode elicitation; a bare `{}` capability means form. */
export function supportsFormElicitation(server: Server): boolean {
  const elicitation = server.getClientCapabilities()?.elicitation
  return elicitation !== undefined && (elicitation.form !== undefined || Object.keys(elicitation).length === 0)
}

/**
 * The `confirm` hook that asks through the client's form, or `undefined` when
 * the client cannot show one. A form that fails to be answered counts as a
 * decline, unless the call itself was aborted.
 */
export function elicitationConfirm(server: Server, signal: AbortSignal): ToolContext["confirm"] {
  if (!supportsFormElicitation(server)) return undefined
  return async (request: ConfirmRequest) => {
    try {
      const answer = await server.elicitInput(
        {
          mode: "form",
          message: request.message,
          requestedSchema: {
            type: "object",
            properties: { confirm: { type: "boolean", title: "Confirm" } },
            required: ["confirm"],
          },
        },
        { signal },
      )
      return answer.action === "accept" && answer.content?.confirm === true
    } catch (error) {
      if (signal.aborted) throw error
      return false
    }
  }
}
