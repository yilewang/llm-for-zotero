import type {
  AgentToolResult,
  AgentPendingAction,
  AgentConfirmationResolution,
  PreparedToolExecution,
  PreparedToolExecutionResult,
} from "../../types";

/** Both conversational and action UI callers return real selections through this resolver. */
export async function resolvePreparedActionReview(
  prepared: PreparedToolExecution,
  resolve: (
    action: AgentPendingAction,
    requestId: string,
  ) => Promise<AgentConfirmationResolution>,
  isExecutionAllowed: () => boolean = () => true,
): Promise<PreparedToolExecutionResult> {
  let current = prepared;
  let resolution: AgentConfirmationResolution | undefined;
  while (current.kind === "confirmation") {
    resolution = await resolve(current.action, current.requestId);
    if (!isExecutionAllowed()) return current.deny();
    current = await current.execute(resolution);
  }
  return resolution
    ? {
        ...current.execution,
        result: attachConfirmationResolution(
          current.execution.result,
          resolution,
        ),
      }
    : current.execution;
}

function attachConfirmationResolution(
  result: AgentToolResult,
  resolution: { actionId?: string; data?: unknown },
): AgentToolResult {
  if (!resolution.actionId) return result;
  const content: Record<string, unknown> =
    result.content &&
    typeof result.content === "object" &&
    !Array.isArray(result.content)
      ? { ...(result.content as Record<string, unknown>) }
      : { value: result.content };
  content.confirmationActionId = resolution.actionId;
  if (resolution.data !== undefined) {
    content.confirmationData = resolution.data;
  }
  return {
    ...result,
    content,
  };
}
