import type { AgentToolContext } from "../types";
import type { AgentToolRegistry } from "../tools/registry";
import type { ZoteroGateway } from "../services/zoteroGateway";
import type {
  ActionConfirmationMode,
  ActionCheckpoint,
  ActionExecutionContext,
  ActionProgressEvent,
} from "./types";
import { getTurnPapersWithRoles } from "../context/requestTurnPaperScope";

/**
 * Builds an ActionExecutionContext from a tool call.
 *
 * The batch engine in `src/agent/actions/` is a complete propose → paginate →
 * review → apply → resume system that the model could not reach: the two
 * invocation paths were the chat panel's slash-command controller and the
 * public plugin API. This is the missing adapter.
 *
 * `executor.ts`'s `buildToolContext` performs the exact reverse mapping, and
 * is the reference for `requestContext`.
 */
export function buildActionExecutionContext(params: {
  context: AgentToolContext;
  registry: AgentToolRegistry;
  zoteroGateway: ZoteroGateway;
  confirmationMode: ActionConfirmationMode;
  runId?: string;
  journalActionScope?: ActionExecutionContext["journalActionScope"];
  journalToolName?: string;
  onProgress?: (event: ActionProgressEvent) => void;
  checkpoint?: (checkpoint: ActionCheckpoint) => Promise<void>;
  requestConfirmation?: ActionExecutionContext["requestConfirmation"];
}): ActionExecutionContext {
  const { context } = params;
  const request = context.request;

  return {
    // Registry and gateway are constructor dependencies of the
    // tool that calls this, not data carried on the context.
    registry: params.registry,
    // Carried so every change an action makes is filed under the user's real
    // conversation. Without this the executor's synthetic request used 0,
    // and neither undo path could ever find the entries.
    conversationKey: request.conversationKey,
    runId: params.runId,
    journalActionScope: params.journalActionScope,
    journalToolName: params.journalToolName,
    zoteroGateway: params.zoteroGateway,
    libraryID: Number(request.libraryID) > 0 ? Number(request.libraryID) : 1,
    confirmationMode: params.confirmationMode,
    /**
     * Progress has no channel back through a tool call: the runtime's `emit`
     * is a per-turn closure that tool code cannot reach. Under the paged
     * design the tool returns after one page anyway, so progress events are
     * collected by the caller (or dropped) rather than streamed.
     */
    onProgress: params.onProgress ?? (() => undefined),
    checkpoint: params.checkpoint,
    /**
     * Actions ported to the paged tool never call this — the runtime owns
     * confirmation now. It throws rather than silently auto-approving,
     * because an action that unexpectedly asks for confirmation is a bug
     * that must be loud, not a write that quietly proceeds unreviewed.
     */
    requestConfirmation:
      params.requestConfirmation ??
      (async () => {
        throw new Error(
          "This action requested an inline confirmation, which the paged tool path cannot satisfy. Run it from the slash-command surface, or port it to the paged review flow.",
        );
      }),
    llm: buildActionLlmConfig(context),
    requestContext: {
      mode: request.conversationKind === "paper" ? "paper" : "library",
      activeItemId: request.activeItemId,
      selectedPaperContexts: [...getTurnPapersWithRoles(request, ["selected"])],
      fullTextPaperContexts: [
        ...getTurnPapersWithRoles(request, ["full_text"]),
      ],
      selectedCollectionContexts: [...request.turnPaperScope.collections],
      selectedTagContexts: [...request.turnPaperScope.tags],
      actionContract: request.actionContract,
      actionProgress: request.actionProgress,
    },
    signal: context.signal,
  };
}

/**
 * Batch iterations route through the bounded utility layer rather than the
 * main conversation model — a 5,000-item job is hundreds of calls, and
 * `callUtilityLLM` already enforces a reasoning floor and a token budget.
 */
function buildActionLlmConfig(
  context: AgentToolContext,
): ActionExecutionContext["llm"] {
  const request = context.request;
  const model = (request.model || "").trim();
  const apiBase = (request.apiBase || "").trim();
  if (!model || !apiBase) return undefined;
  return {
    model,
    apiBase,
    apiKey: request.apiKey,
    authMode: request.authMode,
    providerProtocol: request.providerProtocol,
    profileOverride: request.advanced?.profileOverride,
  };
}
