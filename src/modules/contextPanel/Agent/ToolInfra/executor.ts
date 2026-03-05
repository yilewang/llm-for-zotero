import { getAgentToolDefinition } from "./registry";
import { resolveAgentToolTarget } from "./resolveTarget";
import { executeListPapersCall } from "../Tools/listPapers";
import { executeSearchInternetCall } from "../Tools/searchInternet";
import { sanitizeText } from "../../textUtils";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  AgentToolExecutorState,
} from "./types";

export function createAgentToolExecutorState(): AgentToolExecutorState {
  return {
    executedCallKeys: new Set<string>(),
    totalEstimatedTokens: 0,
    executedCallCount: 0,
  };
}

function buildSkipResult(
  call: AgentToolCall,
  targetLabel: string,
  message: string,
): AgentToolExecutionResult {
  return {
    name: call.name,
    targetLabel,
    ok: false,
    traceLines: [message],
    groundingText: "",
    addedPaperContexts: [],
    estimatedTokens: 0,
    truncated: false,
  };
}

function buildListPapersCallKey(call: AgentToolCall): string {
  const query = sanitizeText(call.query || "").trim();
  const depth = call.depth === "abstract" ? "abstract" : "metadata";
  return `list_papers:${query || "overview"}:${call.limit ?? 6}:${depth}`;
}

export async function executeAgentToolCall(params: {
  call?: AgentToolCall | null;
  ctx: AgentToolExecutionContext;
  state: AgentToolExecutorState;
}): Promise<AgentToolExecutionResult | null> {
  if (!params.call) return null;

  // ── search_internet: no paper-target resolution needed ─────────────────────
  if (params.call.name === "search_internet") {
    const callKey = `search_internet:${sanitizeText(params.call.query || "").trim()}:${params.call.limit ?? 6}`;
    if (params.state.executedCallKeys.has(callKey)) {
      return buildSkipResult(
        params.call,
        `internet: "${params.call.query}"`,
        "Duplicate search_internet call was ignored.",
      );
    }
    const result = await executeSearchInternetCall(params.call, params.ctx);
    if (result.ok) {
      params.state.executedCallKeys.add(callKey);
      params.state.totalEstimatedTokens += result.estimatedTokens;
      params.state.executedCallCount += 1;
    }
    return result;
  }

  // ── list_papers: library tool — no paper-target resolution needed ──────────
  if (params.call.name === "list_papers") {
    const callKey = buildListPapersCallKey(params.call);
    if (params.state.executedCallKeys.has(callKey)) {
      return buildSkipResult(
        params.call,
        "library",
        "Duplicate list_papers call was ignored.",
      );
    }
    const result = await executeListPapersCall(params.call, params.ctx);
    if (result.ok) {
      params.state.executedCallKeys.add(callKey);
      params.state.totalEstimatedTokens += result.estimatedTokens;
      params.state.executedCallCount += 1;
    }
    return result;
  }

  // ── paper tools: read_paper_text / find_claim_evidence / read_references ───
  const definition = getAgentToolDefinition(params.call.name);
  if (!definition || !definition.execute) {
    return buildSkipResult(
      params.call,
      params.call.name,
      `Unknown tool call was ignored: ${params.call.name}.`,
    );
  }

  const validatedCall = definition.validate(params.call);
  if (!validatedCall) {
    return buildSkipResult(
      params.call,
      params.call.name,
      `Malformed tool call was ignored: ${params.call.name}.`,
    );
  }

  const resolvedTarget = resolveAgentToolTarget(
    params.ctx,
    validatedCall.target!,
  );
  if (!resolvedTarget.paperContext) {
    return buildSkipResult(
      validatedCall,
      resolvedTarget.targetLabel,
      resolvedTarget.error ||
        `Tool target was unavailable: ${resolvedTarget.targetLabel}.`,
    );
  }

  const callKey = `${validatedCall.name}:${resolvedTarget.resolvedKey || resolvedTarget.targetLabel}`;
  if (params.state.executedCallKeys.has(callKey)) {
    return buildSkipResult(
      validatedCall,
      resolvedTarget.targetLabel,
      `Duplicate tool call was ignored: ${validatedCall.name}(${resolvedTarget.targetLabel}).`,
    );
  }

  const result = await definition.execute(
    params.ctx,
    validatedCall,
    resolvedTarget,
  );
  if (!result.ok) return result;

  params.state.executedCallKeys.add(callKey);
  params.state.totalEstimatedTokens += result.estimatedTokens;
  params.state.executedCallCount += 1;
  return result;
}
