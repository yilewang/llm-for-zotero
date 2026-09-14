import { resolvePreparedActionReview } from "../tools/execution/review";
import { withConversationWriteLock } from "../../shared/conversationWriteFence";
import { resolveAgentRuntimeRequest } from "../context/resolvedAgentRequest";
import type {
  AgentToolCall,
  AgentToolContext,
  AgentToolResult,
  PreparedToolExecution,
} from "../types";
import type { ActionExecutionContext } from "./types";

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
  if (ctx.toolContext)
    return {
      ...ctx.toolContext,
      request: {
        ...ctx.toolContext.request,
        actionEntryPoint:
          ctx.requestContext?.actionEntryPoint || "conversation",
        actionContract:
          ctx.requestContext?.actionContract ||
          ctx.toolContext.request.actionContract,
        actionProgress:
          ctx.requestContext?.actionProgress ||
          ctx.toolContext.request.actionProgress,
        classifiedIntent:
          ctx.requestContext?.classifiedIntent ||
          ctx.toolContext.request.classifiedIntent,
      },
      signal: ctx.signal || ctx.toolContext.signal,
      journalActionScope:
        ctx.journalActionScope || ctx.toolContext.journalActionScope,
      journalToolName: ctx.journalToolName || ctx.toolContext.journalToolName,
    };
  return {
    signal: ctx.signal,
    // Actions run outside an agent turn, so we build a synthetic request.
    request: resolveAgentRuntimeRequest({
      // Carried from the caller. Hard-coding 0 filed every action-driven
      // change under a conversation nothing queries, so neither undo path
      // could find them.
      conversationKey: ctx.conversationKey ?? 0,
      mode: "agent",
      actionEntryPoint: ctx.requestContext?.actionEntryPoint || "action_ui",
      classifiedIntent: ctx.requestContext?.classifiedIntent,
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

/**
 * Executes a single tool call from within an action step.
 *
 * - Calls `registry.prepareExecution()` to validate input and check confirmation.
 * - If the tool returns a direct result, returns it immediately.
 * - If the tool requires confirmation, routes based on `ctx.confirmationMode`:
 *   - `"automatic"` — central policy grants direct authority or surfaces required review.
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
  inheritedApproval?: import("../types").AgentInheritedApproval,
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
    // Preserve the originating authority and lifetime across the shared action pipeline.
    {
      callerKind:
        ctx.toolContext && ctx.requestContext?.actionEntryPoint !== "action_ui"
          ? "model"
          : "action",
      ...toolContext.nestedExecutionOptions,
      executeWithLock:
        toolContext.nestedExecutionOptions?.executeWithLock ||
        ((task) =>
          withConversationWriteLock(toolContext.request.conversationKey, task)),
      checkpointedWorkflow: Boolean(ctx.journalActionScope),
      inheritedApproval,
      // Native action pages are an explicit review workflow. Preserve that
      // workflow even when the operation is fully reversible and the global
      // write mode would otherwise auto-approve it.
      forceConfirmation:
        ctx.requestContext?.actionEntryPoint !== "conversation",
    },
  );

  const deliver = (result: AgentToolResult) => {
    ctx.toolContext?.recordChildExecution?.(result);
    return result;
  };
  if (prepared.kind === "result") return deliver(prepared.execution.result);
  if (ctx.resolvePreparedAction)
    return deliver((await ctx.resolvePreparedAction(prepared)).result);

  return deliver(
    (
      await resolvePreparedActionReview(
        prepared,
        async (action, requestId) => {
          ctx.onProgress({ type: "confirmation_required", requestId, action });
          return ctx.requestConfirmation(requestId, action);
        },
        toolContext.nestedExecutionOptions?.isExecutionAllowed,
      )
    ).result,
  );
}
