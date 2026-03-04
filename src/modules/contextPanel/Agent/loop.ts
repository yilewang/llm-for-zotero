/**
 * agentLoop.ts — open-ended ReAct retrieval loop.
 */

import type { ReasoningConfig } from "../../../utils/llmClient";
import { getModelInputTokenLimit } from "../../../utils/modelInputCap";
import {
  normalizeInputTokenCap,
  normalizeMaxTokens,
} from "../../../utils/normalization";
import { resolvePaperContextRefFromAttachment } from "../paperAttribution";
import { sanitizeText } from "../textUtils";
import { shouldSkipAgent } from "./heuristics";
import { runAgentStep } from "./step";
import { DEFAULT_MAX_AGENT_ITERATIONS } from "./config";
import {
  createAgentToolExecutorState,
  executeAgentToolCall,
} from "./Tools/executor";
import type { AgentStepContext, AgentStepDecision, AgentExecutedStep } from "./types";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
} from "./Tools/types";
import type { AdvancedModelParams, Message, PaperContextRef } from "../types";

// ── Public types ──────────────────────────────

export type AgentLoopParams = {
  item: Zotero.Item;
  question: string;
  activeContextItem: Zotero.Item | null;
  conversationMode: "paper" | "open";
  paperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  historyMessages?: Message[];
  model: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: ReasoningConfig;
  advanced?: AdvancedModelParams;
  availableContextBudgetTokens?: number;
  /** Override the default iteration cap (default: DEFAULT_MAX_AGENT_ITERATIONS). */
  maxIterations?: number;
  /**
   * Base-64 encoded image strings attached to the request (figures, screenshots, etc.).
   * When present the agent loop skips immediately — all agent tools operate on text,
   * so retrieval cannot help with a vision-focused question.
   */
  images?: string[];
  onStatus?: (statusText: string) => void;
  onTrace?: (line: string) => void;
};

export type AgentLoopResult = {
  activeContextItem: Zotero.Item | null;
  conversationMode: "paper" | "open";
  paperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  contextPrefix: string;
};

export type AgentLoopDeps = {
  runAgentStep: (ctx: AgentStepContext) => Promise<AgentStepDecision>;
  executeAgentToolCall: typeof executeAgentToolCall;
};

// ── Internal state ────────────────────────────

type AgentLoopState = {
  activeContextItem: Zotero.Item | null;
  conversationMode: "paper" | "open";
  activePaperContext: PaperContextRef | null;
  paperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  retrievedPaperContexts: PaperContextRef[];
  contextPrefixBlocks: string[];
  contextPrefixEstimatedTokens: number;
  executedSteps: AgentExecutedStep[];
};

// ── Helpers ───────────────────────────────────

function dedupePaperContexts(
  values: (PaperContextRef | null | undefined)[],
): PaperContextRef[] {
  const out: PaperContextRef[] = [];
  const seen = new Set<string>();
  for (const value of values) {
    if (!value) continue;
    const key = `${value.itemId}:${value.contextItemId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

function formatToolCallLabel(call: AgentToolCall): string {
  if (call.name === "list_papers" || call.name === "search_internet") {
    const query = sanitizeText(call.query || "").trim();
    return query ? `${call.name}("${query}")` : `${call.name}()`;
  }
  if (call.target) {
    const target =
      "index" in call.target
        ? `${call.target.scope}#${call.target.index}`
        : call.target.scope;
    return `${call.name}(${target})`;
  }
  return call.name;
}

function summarizeToolResult(result: AgentToolExecutionResult): AgentExecutedStep {
  return {
    toolName: result.name,
    targetLabel: result.targetLabel,
    ok: result.ok,
    summary: `${result.name} | ${result.targetLabel} | ${result.ok ? "complete" : "skipped"}`,
  };
}

function summarizeHistoryMessages(historyMessages?: Message[]): string[] {
  if (!historyMessages?.length) return [];
  return historyMessages
    .slice(-8)
    .map((message) => {
      const role = message.role === "assistant" ? "assistant" : "user";
      const text = sanitizeText(message.text || "")
        .replace(/\s+/g, " ")
        .trim()
        .slice(0, 180);
      return text ? `${role}: ${text}` : "";
    })
    .filter(Boolean);
}

function derivePreviousAssistantAnswerText(historyMessages?: Message[]): string {
  if (!historyMessages?.length) return "";
  for (let i = historyMessages.length - 1; i >= 0; i -= 1) {
    const message = historyMessages[i];
    if (!message || message.role !== "assistant") continue;
    const text = sanitizeText(message.text || "").trim();
    if (!text) continue;
    if (text === "[Cancelled]") continue;
    if (/^Error:/i.test(text)) continue;
    return text;
  }
  return "";
}

function deriveAvailableContextBudgetTokens(params: AgentLoopParams): number {
  const explicitBudget = Math.floor(Number(params.availableContextBudgetTokens));
  if (Number.isFinite(explicitBudget) && explicitBudget >= 0) return explicitBudget;
  const modelLimitTokens = getModelInputTokenLimit(params.model);
  const limitTokens = normalizeInputTokenCap(params.advanced?.inputTokenCap, modelLimitTokens);
  const softLimitTokens = Math.max(1, Math.floor(limitTokens * 0.9));
  const outputReserveTokens = normalizeMaxTokens(params.advanced?.maxTokens);
  return Math.max(0, softLimitTokens - outputReserveTokens);
}

/** Divide remaining budget evenly across remaining iterations. */
function computeToolTokenCap(
  totalBudget: number,
  state: AgentLoopState,
  maxIterations: number,
  iterationIndex: number,
): number {
  const remainingBudget = Math.max(0, totalBudget - state.contextPrefixEstimatedTokens);
  if (remainingBudget <= 0) return 0;
  const remainingIterations = Math.max(1, maxIterations - iterationIndex);
  return Math.max(1, Math.floor(remainingBudget / remainingIterations));
}

function buildToolContext(
  params: AgentLoopParams,
  state: AgentLoopState,
  previousAssistantAnswerText: string,
  toolTokenCap?: number,
): AgentToolExecutionContext {
  return {
    question: params.question,
    previousAssistantAnswerText: previousAssistantAnswerText || undefined,
    libraryID: Number(params.item.libraryID),
    panelItemId: params.item.id,
    conversationMode: state.conversationMode,
    activePaperContext: state.activePaperContext,
    selectedPaperContexts: state.paperContexts,
    pinnedPaperContexts: state.pinnedPaperContexts,
    recentPaperContexts: state.recentPaperContexts,
    retrievedPaperContexts: state.retrievedPaperContexts,
    toolTokenCap,
    availableContextBudgetTokens: params.availableContextBudgetTokens,
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    model: params.model,
    onTrace: params.onTrace,
    onStatus: params.onStatus,
  };
}

function buildStepContext(
  params: AgentLoopParams,
  state: AgentLoopState,
  historySummaryLines: string[],
  previousAssistantAnswerText: string,
  iterationIndex: number,
  maxIterations: number,
  remainingBudgetTokens: number,
): AgentStepContext {
  return {
    question: params.question,
    conversationMode: state.conversationMode,
    libraryID: Number(params.item.libraryID),
    model: params.model,
    apiBase: params.apiBase,
    apiKey: params.apiKey,
    reasoning: params.reasoning,
    iterationIndex,
    maxIterations,
    activePaperContext: state.activePaperContext,
    selectedPaperContexts: state.paperContexts,
    pinnedPaperContexts: state.pinnedPaperContexts,
    recentPaperContexts: state.recentPaperContexts,
    retrievedPaperContexts: state.retrievedPaperContexts,
    executedSteps: state.executedSteps,
    historySummaryLines,
    previousAssistantAnswerAvailable: Boolean(previousAssistantAnswerText),
    previousAssistantAnswerPreview: previousAssistantAnswerText
      ? previousAssistantAnswerText.slice(0, 400)
      : undefined,
    remainingBudgetTokens,
  };
}

/**
 * Apply a successful tool result to the loop state.
 * list_papers switches the loop into library mode.
 * Paper tools add grounding text and new paper contexts.
 */
function applyToolResult(
  state: AgentLoopState,
  result: AgentToolExecutionResult,
  call: AgentToolCall,
): void {
  const groundingText = sanitizeText(result.groundingText || "").trim();
  if (groundingText) {
    state.contextPrefixBlocks.push(groundingText);
    state.contextPrefixEstimatedTokens += result.estimatedTokens;
  }

  if (call.name === "list_papers" && result.retrievedPaperContexts?.length) {
    // Switch to library mode: replace existing contexts with library papers.
    state.retrievedPaperContexts = result.retrievedPaperContexts;
    state.paperContexts = [...result.retrievedPaperContexts];
    state.pinnedPaperContexts = [...result.retrievedPaperContexts];
    state.recentPaperContexts = [];
    state.conversationMode = "open";
    state.activeContextItem = null;
  } else if (result.addedPaperContexts.length) {
    state.paperContexts = dedupePaperContexts([
      ...state.paperContexts,
      ...result.addedPaperContexts,
    ]);
  }

  state.executedSteps.push(summarizeToolResult(result));
}

// ── Loop runner factory ───────────────────────

const defaultDeps: AgentLoopDeps = {
  runAgentStep,
  executeAgentToolCall,
};

export function createAgentLoopRunner(
  deps: Partial<AgentLoopDeps> = {},
): (params: AgentLoopParams) => Promise<AgentLoopResult> {
  const resolvedDeps: AgentLoopDeps = { ...defaultDeps, ...deps };

  return async function run(params: AgentLoopParams): Promise<AgentLoopResult> {
    const state: AgentLoopState = {
      activeContextItem: params.activeContextItem,
      conversationMode: params.conversationMode,
      activePaperContext: resolvePaperContextRefFromAttachment(params.activeContextItem),
      paperContexts: [...params.paperContexts],
      pinnedPaperContexts: [...params.pinnedPaperContexts],
      recentPaperContexts: [...params.recentPaperContexts],
      retrievedPaperContexts: [],
      contextPrefixBlocks: [],
      contextPrefixEstimatedTokens: 0,
      executedSteps: [],
    };

    const rawMaxIterations = Math.floor(Number(params.maxIterations || 0));
    const maxIterations = rawMaxIterations > 0 ? rawMaxIterations : DEFAULT_MAX_AGENT_ITERATIONS;

    const libraryID = Number(params.item.libraryID);
    const hasExistingPaperContexts =
      dedupePaperContexts([
        ...state.paperContexts,
        ...state.pinnedPaperContexts,
        ...state.recentPaperContexts,
      ]).length > 0;

    // Fast-path: nothing to retrieve — skip all LLM calls.
    if (
      shouldSkipAgent({
        question: params.question,
        libraryID,
        hasActivePaper: Boolean(state.activePaperContext),
        hasExistingPaperContexts,
        hasImages: (params.images?.length ?? 0) > 0,
      })
    ) {
      return {
        activeContextItem: state.activeContextItem,
        conversationMode: state.conversationMode,
        paperContexts: state.paperContexts,
        pinnedPaperContexts: state.pinnedPaperContexts,
        recentPaperContexts: state.recentPaperContexts,
        contextPrefix: "",
      };
    }

    params.onTrace?.("Planning Zotero retrieval...");

    const totalBudget = deriveAvailableContextBudgetTokens(params);
    const executorState = createAgentToolExecutorState();
    const historySummaryLines = summarizeHistoryMessages(params.historyMessages);
    const previousAssistantAnswerText = derivePreviousAssistantAnswerText(
      params.historyMessages,
    );

    for (let i = 0; i < maxIterations; i++) {
      const remainingBudget = Math.max(
        0,
        totalBudget - state.contextPrefixEstimatedTokens,
      );
      if (remainingBudget <= 0) {
        params.onTrace?.("Context budget exhausted; stopping retrieval.");
        break;
      }

      // One LLM call: decide the next step.
      const stepCtx = buildStepContext(
        params,
        state,
        historySummaryLines,
        previousAssistantAnswerText,
        i,
        maxIterations,
        remainingBudget,
      );
      const decision = await resolvedDeps.runAgentStep(stepCtx);

      for (const line of decision.traceLines) {
        params.onTrace?.(line);
      }

      if (decision.type === "stop") break;

      // Execute the chosen tool.
      const toolLabel = formatToolCallLabel(decision.call);
      params.onTrace?.(`Tool call: ${toolLabel}.`);

      const toolTokenCap = computeToolTokenCap(totalBudget, state, maxIterations, i);
      if (toolTokenCap <= 0) {
        params.onTrace?.(`No remaining context budget for ${toolLabel}; stopping retrieval.`);
        break;
      }

      const result = await resolvedDeps.executeAgentToolCall({
        call: decision.call,
        ctx: buildToolContext(
          params,
          state,
          previousAssistantAnswerText,
          toolTokenCap,
        ),
        state: executorState,
      });

      if (!result) continue;

      for (const line of result.traceLines) {
        params.onTrace?.(line);
      }

      if (result.ok) {
        applyToolResult(state, result, decision.call);
        // write_note and fix_metadata are terminal — they complete the user's
        // request in full.  Stop immediately so the planner never re-issues them.
        if (
          decision.call.name === "write_note" ||
          decision.call.name === "fix_metadata"
        ) {
          break;
        }
      } else {
        // Record the failed step so subsequent iterations avoid repeating it.
        state.executedSteps.push(summarizeToolResult(result));
      }
    }

    return {
      activeContextItem: state.activeContextItem,
      conversationMode: state.conversationMode,
      paperContexts: state.paperContexts,
      pinnedPaperContexts: state.pinnedPaperContexts,
      recentPaperContexts: state.recentPaperContexts,
      contextPrefix: state.contextPrefixBlocks
        .map((block) => sanitizeText(block).trim())
        .filter(Boolean)
        .join("\n\n---\n\n"),
    };
  };
}

export const runAgentLoop = createAgentLoopRunner();
