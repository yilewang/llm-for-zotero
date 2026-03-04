import { estimateTextTokens } from "../../../../utils/modelInputCap";
import { resolveAgentContext } from "../context";
import { sanitizeText } from "../../textUtils";
import type { AgentToolCall, AgentToolExecutionContext, AgentToolExecutionResult } from "./types";

/**
 * Executes the list_papers tool: lists or searches the active Zotero library,
 * returning a metadata prefix and a set of PaperContextRef entries that become
 * available as "retrieved-paper#N" targets for subsequent tool calls.
 */
export async function executeListPapersCall(
  call: AgentToolCall,
  ctx: AgentToolExecutionContext,
): Promise<AgentToolExecutionResult> {
  const libraryID = ctx.libraryID;
  const query = sanitizeText(call.query || "").trim();
  const limit = Math.max(1, Math.min(12, Math.floor(Number(call.limit || 0)) || 6));

  const errorResult = (message: string): AgentToolExecutionResult => ({
    name: "list_papers",
    targetLabel: "library",
    ok: false,
    traceLines: [message],
    groundingText: "",
    addedPaperContexts: [],
    retrievedPaperContexts: [],
    estimatedTokens: 0,
    truncated: false,
  });

  if (!libraryID || libraryID <= 0) {
    return errorResult("No Zotero library is available.");
  }

  const action = query ? "library-search" : "library-overview";

  const result = await resolveAgentContext({
    question: ctx.question,
    libraryID,
    conversationMode: ctx.conversationMode,
    plan: {
      action,
      searchQuery: query || undefined,
      maxPapersToRead: limit,
    },
    availableContextBudgetTokens: ctx.availableContextBudgetTokens,
    onStatus: ctx.onStatus,
  });

  if (!result) {
    return errorResult("Library retrieval returned no result.");
  }

  const groundingText = sanitizeText(result.contextPrefix || "").trim();
  return {
    name: "list_papers",
    targetLabel: query ? `library search: "${query}"` : "library overview",
    ok: true,
    traceLines: result.traceLines,
    groundingText,
    addedPaperContexts: result.paperContexts,
    retrievedPaperContexts: result.paperContexts,
    estimatedTokens: estimateTextTokens(groundingText),
    truncated: false,
  };
}

export function validateListPapersCall(call: AgentToolCall): AgentToolCall | null {
  if (call.name !== "list_papers") return null;
  const query = sanitizeText(call.query || "").trim();
  const rawLimit = Number(call.limit || 0);
  const limit = Number.isFinite(rawLimit) && rawLimit > 0
    ? Math.max(1, Math.min(12, Math.floor(rawLimit)))
    : 6;
  return { name: "list_papers", query: query || undefined, limit };
}
