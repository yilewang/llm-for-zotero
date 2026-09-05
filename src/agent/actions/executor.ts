import type {
  AgentToolCall,
  AgentToolContext,
  AgentToolResult,
  PreparedToolExecution,
} from "../types";
import type { ActionExecutionContext } from "./types";
import { resolveAgentRuntimeRequest } from "../context/resolvedAgentRequest";

let _callCounter = 0;
function nextCallId(): string {
  return `action-call-${Date.now()}-${++_callCounter}`;
}

/**
 * Creates a minimal AgentToolContext for invoking a tool directly from an action.
 * Actions don't have a real user request, so we synthesise one.
 */
function buildToolContext(
  ctx: ActionExecutionContext,
  stepDescription: string,
): AgentToolContext {
  const syntheticItem = ctx.requestContext?.activeItemId
    ? ctx.zoteroGateway.getItem(ctx.requestContext.activeItemId)
    : null;
  return {
    // Actions run outside an agent turn, so we build a synthetic request.
    request: resolveAgentRuntimeRequest({
      // Carried from the caller. Hard-coding 0 filed every action-driven
      // change under a conversation nothing queries, so neither undo path
      // could find them.
      conversationKey: ctx.conversationKey ?? 0,
      mode: "agent",
      userText: stepDescription,
      libraryID: ctx.libraryID,
      activeItemId: ctx.requestContext?.activeItemId,
      selectedPaperContexts: ctx.requestContext?.selectedPaperContexts,
      fullTextPaperContexts: ctx.requestContext?.fullTextPaperContexts,
      selectedCollectionContexts:
        ctx.requestContext?.selectedCollectionContexts,
      selectedTagContexts: ctx.requestContext?.selectedTagContexts,
      actionContract: ctx.requestContext?.actionContract,
      actionProgress: ctx.requestContext?.actionProgress,
    }),
    runId: ctx.runId,
    item: syntheticItem,
    currentAnswerText: "",
    modelName: "action",
    journalActionScope: ctx.journalActionScope,
    journalToolName: ctx.journalToolName,
  };
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

function withConfirmationActionId(
  data: unknown,
  actionId: string | undefined,
): unknown {
  if (!actionId) return data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { ...(data as Record<string, unknown>), __actionId: actionId };
  }
  return { __actionId: actionId, value: data };
}

/**
 * Executes a single tool call from within an action step.
 *
 * - Calls `registry.prepareExecution()` to validate input and check confirmation.
 * - If the tool returns a direct result, returns it immediately.
 * - If the tool requires confirmation, routes based on `ctx.confirmationMode`:
 *   - `"auto_approve"` — calls `execute()` without asking the user.
 *   - `"native_ui"` — emits a `confirmation_required` progress event and awaits
 *     the caller's `requestConfirmation()` to get the user's resolution.
 *   - `"mcp_response"` — same as native_ui; the MCP server handles the pause.
 *
 * NOTE: This function only handles `prepareExecution` (validation + confirmation).
 * It does NOT run the runtime's result-review loop (createResultReviewAction /
 * resolveResultReview). This means tools like search_literature_online will
 * return raw results without triggering per-item review cards — which is the
 * desired behavior for batch actions that gather data in a loop and present
 * one consolidated confirmation at the end.
 */
export async function callTool(
  toolName: string,
  args: unknown,
  ctx: ActionExecutionContext,
  stepDescription = "",
): Promise<AgentToolResult> {
  const call: AgentToolCall = {
    id: nextCallId(),
    name: toolName,
    arguments: args,
  };
  const toolContext = buildToolContext(ctx, stepDescription || toolName);
  const prepared: PreparedToolExecution = await ctx.registry.prepareExecution(
    call,
    toolContext,
    // An action is started by an explicit user gesture (a slash command or
    // the action picker), which is its own consent — autonomy gates that
    // bound the model's tool loop do not apply here.
    {
      callerKind: "action",
      // Native action pages are an explicit review workflow. Preserve that
      // workflow even when the operation is fully reversible and the global
      // write mode would otherwise auto-approve it.
      forceConfirmation: ctx.confirmationMode !== "auto_approve",
    },
  );

  if (prepared.kind === "result") {
    return prepared.execution.result;
  }

  // Confirmation required
  if (ctx.confirmationMode === "auto_approve") {
    const execution = await prepared.execute(undefined);
    return execution.result;
  }

  // native_ui or mcp_response: surface the confirmation card to the caller
  ctx.onProgress({
    type: "confirmation_required",
    requestId: prepared.requestId,
    action: prepared.action,
  });

  const resolution = await ctx.requestConfirmation(
    prepared.requestId,
    prepared.action,
  );

  if (!resolution.approved) {
    return attachConfirmationResolution(prepared.deny(resolution.data).result, {
      actionId: resolution.actionId,
      data: resolution.data,
    });
  }

  const execution = await prepared.execute(
    withConfirmationActionId(resolution.data, resolution.actionId),
  );
  return attachConfirmationResolution(execution.result, {
    actionId: resolution.actionId,
    data: resolution.data,
  });
}
