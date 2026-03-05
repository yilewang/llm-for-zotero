import { estimateTextTokens } from "../../../../utils/modelInputCap";
import { resolveAgentContext } from "../ToolInfra/context";
import { sanitizeText } from "../../textUtils";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  ListPapersDepth,
} from "../ToolInfra/types";

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
  const rawLimit = Number(call.limit || 0);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.max(1, Math.floor(rawLimit))
      : undefined;
  const depth: ListPapersDepth =
    call.depth === "abstract" ? "abstract" : "metadata";

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
      depth,
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
    depthAchieved: result.depthAchieved,
    sufficiency: result.sufficiency,
    estimatedTokens: estimateTextTokens(groundingText),
    truncated: false,
  };
}

export function validateListPapersCall(
  call: AgentToolCall,
): AgentToolCall | null {
  if (call.name !== "list_papers") return null;
  const rawDepth = sanitizeText(String(call.depth || ""))
    .trim()
    .toLowerCase();
  if (rawDepth && rawDepth !== "metadata" && rawDepth !== "abstract") {
    return null;
  }
  const query = sanitizeText(call.query || "").trim();
  const rawLimit = Number(call.limit || 0);
  const limit =
    Number.isFinite(rawLimit) && rawLimit > 0
      ? Math.max(1, Math.floor(rawLimit))
      : undefined;
  const depth: ListPapersDepth = rawDepth === "abstract" ? "abstract" : "metadata";
  return { name: "list_papers", query: query || undefined, limit, depth };
}
