import { getModelInputTokenLimit } from "../../../utils/modelInputCap";
import {
  normalizeInputTokenCap,
  normalizeMaxTokens,
} from "../../../utils/normalization";
import {
  DEFAULT_MAX_AGENT_ITERATIONS,
  MAX_NO_PROGRESS_STEPS,
  MAX_ROUTER_CONTEXT_DESCRIPTORS,
  MAX_ROUTER_HISTORY_LINES,
  MAX_ROUTER_HISTORY_LINE_CHARS,
  MAX_ROUTER_TOOL_LOG_LINES,
  MAX_ROUTER_TOOL_LOG_RECENT_LINES,
  ROUTER_CONTEXT_BUDGET_SOFT_RATIO,
} from "./config";
import { shouldSkipAgent } from "./heuristics";
import { resolvePaperContextRefFromAttachment } from "../paperAttribution";
import { sanitizeText } from "../textUtils";
import {
  deriveRetrievalPolicy,
  isDeepPaperTool,
  type AgentDepthLevel,
  type AgentSufficiency,
} from "./retrievalPolicy";
import type {
  AgentToolCall,
  AgentToolExecutionContext,
  AgentToolExecutionResult,
  AgentToolName,
} from "./ToolInfra/types";
import type { Message, PaperContextRef } from "../types";
import { loadAgentPromptPack } from "./promptPack";
import { buildResponderContextBlock } from "./responseComposer";
import { runAgentRouterStep } from "./router";
import {
  createAgentToolBrokerState,
  executeToolViaBroker,
  getToolSpecs,
} from "./toolBroker";
import type {
  AgentOrchestratorParams,
  AgentOrchestratorResult,
  AgentToolLog,
  RouterContextSummary,
  UiActionDirective,
} from "./types";

type AgentState = {
  activeContextItem: Zotero.Item | null;
  conversationMode: "paper" | "open";
  activePaperContext: PaperContextRef | null;
  paperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  retrievedPaperContexts: PaperContextRef[];
  contextPrefixBlocks: string[];
  contextPrefixEstimatedTokens: number;
  toolLogs: AgentToolLog[];
  uiActions: UiActionDirective[];
};

const DEPTH_RANK: Record<AgentDepthLevel, number> = {
  metadata: 1,
  abstract: 2,
  deep: 3,
};

function mergeDepthLevel(
  current: AgentDepthLevel,
  next: AgentDepthLevel,
): AgentDepthLevel {
  return DEPTH_RANK[next] > DEPTH_RANK[current] ? next : current;
}

function buildAllowedToolNames(maxDepthAllowed: AgentDepthLevel): Set<string> {
  const out = new Set<string>(getToolSpecs().map((spec) => spec.name));
  if (maxDepthAllowed === "deep") return out;
  for (const name of Array.from(out)) {
    if (isDeepPaperTool(name as AgentToolName)) {
      out.delete(name);
    }
  }
  return out;
}

function enforcePolicyOnToolCall(params: {
  call: AgentToolCall;
  maxDepthAllowed: AgentDepthLevel;
  metadataAttempted: boolean;
  latestSufficiency: AgentSufficiency | null;
}): AgentToolCall | null {
  if (
    params.maxDepthAllowed !== "deep" &&
    isDeepPaperTool(params.call.name as AgentToolName)
  ) {
    return null;
  }

  if (params.call.name !== "list_papers") {
    return params.call;
  }

  let depth: "metadata" | "abstract" =
    params.call.depth === "abstract" ? "abstract" : "metadata";
  if (params.maxDepthAllowed === "metadata") {
    depth = "metadata";
  } else if (params.maxDepthAllowed === "abstract") {
    if (!params.metadataAttempted) {
      depth = "metadata";
    } else if (params.latestSufficiency !== "high") {
      depth = "abstract";
    } else {
      depth = "metadata";
    }
  }

  return { ...params.call, depth };
}

function buildPolicyHints(params: {
  intent: string;
  maxDepthAllowed: AgentDepthLevel;
  metadataAttempted: boolean;
  abstractAttempted: boolean;
  latestSufficiency: AgentSufficiency | null;
}): string[] {
  const hints = [
    `intent: ${params.intent}`,
    `max depth allowed: ${params.maxDepthAllowed}`,
  ];
  if (params.maxDepthAllowed === "abstract") {
    hints.push("stage rule: metadata first, then abstract only if needed.");
  }
  if (params.metadataAttempted) {
    hints.push("metadata stage already executed.");
  }
  if (params.abstractAttempted) {
    hints.push("abstract stage already executed.");
  }
  if (params.latestSufficiency) {
    hints.push(`latest sufficiency: ${params.latestSufficiency}`);
  }
  return hints;
}

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

function summarizePaperRef(ref: PaperContextRef): string {
  const bits = [ref.title || "Untitled paper"];
  const citationBits = [ref.firstCreator, ref.year].filter(Boolean).join(", ");
  if (citationBits) {
    bits.push(`(${citationBits})`);
  }
  return bits.join(" ").trim();
}

function formatToolCallLabel(call: AgentToolCall): string {
  if (call.name === "search_internet") {
    const query = sanitizeText(call.query || "").trim();
    return query ? `${call.name}(\"${query}\")` : `${call.name}()`;
  }
  if (call.name === "list_papers") {
    const query = sanitizeText(call.query || "").trim();
    const depth = call.depth === "abstract" ? "abstract" : "metadata";
    return query
      ? `${call.name}(\"${query}\", depth=${depth})`
      : `${call.name}(depth=${depth})`;
  }
  if (call.target) {
    if ("index" in call.target) {
      return `${call.name}(${call.target.scope}#${call.target.index})`;
    }
    return `${call.name}(${call.target.scope})`;
  }
  return call.name;
}

function summarizeToolResult(
  iteration: number,
  result: AgentToolExecutionResult,
): AgentToolLog {
  const extra: string[] = [];
  if (result.depthAchieved) extra.push(`depth=${result.depthAchieved}`);
  if (result.sufficiency) extra.push(`sufficiency=${result.sufficiency}`);
  const summary = [
    result.name,
    result.targetLabel,
    result.ok ? "complete" : "skipped",
    ...extra,
  ].join(" | ");
  return {
    iteration,
    toolName: result.name,
    targetLabel: result.targetLabel,
    ok: result.ok,
    depthAchieved: result.depthAchieved,
    sufficiency: result.sufficiency,
    traceLines: [...result.traceLines],
    summary,
  };
}

function deriveAvailableContextBudgetTokens(
  params: AgentOrchestratorParams,
): number {
  const explicitBudget = Math.floor(
    Number(params.availableContextBudgetTokens),
  );
  if (Number.isFinite(explicitBudget) && explicitBudget >= 0)
    return explicitBudget;
  const modelLimitTokens = getModelInputTokenLimit(params.model);
  const limitTokens = normalizeInputTokenCap(
    params.advanced?.inputTokenCap,
    modelLimitTokens,
  );
  const softLimitTokens = Math.max(
    1,
    Math.floor(limitTokens * ROUTER_CONTEXT_BUDGET_SOFT_RATIO),
  );
  const outputReserveTokens = normalizeMaxTokens(params.advanced?.maxTokens);
  return Math.max(0, softLimitTokens - outputReserveTokens);
}

function computeToolTokenCap(
  totalBudget: number,
  state: AgentState,
  maxIterations: number,
  iterationIndex: number,
): number {
  const remainingBudget = Math.max(
    0,
    totalBudget - state.contextPrefixEstimatedTokens,
  );
  if (remainingBudget <= 0) return 0;
  const remainingIterations = Math.max(1, maxIterations - iterationIndex);
  return Math.max(1, Math.floor(remainingBudget / remainingIterations));
}

function buildToolContext(
  params: AgentOrchestratorParams,
  state: AgentState,
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

function buildAvailableTargetLines(state: AgentState): string[] {
  const lines: string[] = [];

  const selected = dedupePaperContexts(state.paperContexts);
  for (const [i, paper] of selected.entries()) {
    lines.push(`selected-paper#${i + 1}: ${summarizePaperRef(paper)}`);
  }

  const pinned = dedupePaperContexts(state.pinnedPaperContexts);
  for (const [i, paper] of pinned.entries()) {
    lines.push(`pinned-paper#${i + 1}: ${summarizePaperRef(paper)}`);
  }

  const recent = dedupePaperContexts(state.recentPaperContexts);
  for (const [i, paper] of recent.entries()) {
    lines.push(`recent-paper#${i + 1}: ${summarizePaperRef(paper)}`);
  }

  const retrieved = dedupePaperContexts(state.retrievedPaperContexts);
  for (const [i, paper] of retrieved.entries()) {
    lines.push(`retrieved-paper#${i + 1}: ${summarizePaperRef(paper)}`);
  }

  if (state.activePaperContext) {
    lines.push(`active-paper: ${summarizePaperRef(state.activePaperContext)}`);
  }

  return lines;
}

function summarizeConversationHistory(
  messages: Message[] | undefined,
): string[] {
  if (!messages?.length) return [];

  const out: string[] = [];
  const recent = messages.slice(-MAX_ROUTER_HISTORY_LINES);
  for (const message of recent) {
    const role = message.role === "assistant" ? "assistant" : "user";
    const text = sanitizeText(message.text || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, MAX_ROUTER_HISTORY_LINE_CHARS);
    if (text) {
      out.push(`${role}: ${text}`);
    }

    if (role === "assistant") {
      const traceLines = sanitizeText(message.agentTraceText || "")
        .split(/\n+/)
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-MAX_ROUTER_TOOL_LOG_RECENT_LINES)
        .map(
          (line) =>
            `assistant-tool-log: ${line.slice(0, MAX_ROUTER_HISTORY_LINE_CHARS)}`,
        );
      out.push(...traceLines);
    }
  }

  return out.slice(-MAX_ROUTER_HISTORY_LINES);
}

function derivePreviousAssistantAnswerText(messages?: Message[]): string {
  if (!messages?.length) return "";
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.role !== "assistant") continue;
    const text = sanitizeText(message.text || "").trim();
    if (!text) continue;
    if (text === "[Cancelled]") continue;
    if (/^Error:/i.test(text)) continue;
    return text;
  }
  return "";
}

function buildContextDescriptors(params: {
  state: AgentState;
  question: string;
  hasImages: boolean;
  previousAssistantAnswerText: string;
}): string[] {
  const descriptors: string[] = [];
  descriptors.push(
    `question length: ${sanitizeText(params.question).trim().length} characters`,
  );
  descriptors.push(`images attached: ${params.hasImages ? "yes" : "no"}`);
  descriptors.push(
    `previous assistant answer available: ${params.previousAssistantAnswerText ? "yes" : "no"}`,
  );

  if (params.state.activePaperContext) {
    descriptors.push(
      `active context: ${summarizePaperRef(params.state.activePaperContext)}`,
    );
  }

  if (params.state.paperContexts.length) {
    descriptors.push(`selected contexts: ${params.state.paperContexts.length}`);
  }
  if (params.state.pinnedPaperContexts.length) {
    descriptors.push(
      `pinned contexts: ${params.state.pinnedPaperContexts.length}`,
    );
  }
  if (params.state.recentPaperContexts.length) {
    descriptors.push(
      `recent contexts: ${params.state.recentPaperContexts.length}`,
    );
  }
  if (params.state.retrievedPaperContexts.length) {
    descriptors.push(
      `retrieved contexts: ${params.state.retrievedPaperContexts.length}`,
    );
  }

  return descriptors.slice(0, MAX_ROUTER_CONTEXT_DESCRIPTORS);
}

function buildRouterSummary(params: {
  state: AgentState;
  question: string;
  iterationIndex: number;
  maxIterations: number;
  remainingBudgetTokens: number;
  historyMessages?: Message[];
  toolLogs: AgentToolLog[];
  hasImages: boolean;
  libraryID: number;
  previousAssistantAnswerText: string;
  policyHints: string[];
  allowedToolNames: Set<string>;
}): RouterContextSummary {
  const toolSpecs = getToolSpecs().filter((spec) =>
    params.allowedToolNames.has(spec.name),
  );
  return {
    question: params.question,
    conversationMode: params.state.conversationMode,
    libraryAvailable: params.libraryID > 0,
    policyHints: params.policyHints,
    remainingBudgetTokens: params.remainingBudgetTokens,
    iterationIndex: params.iterationIndex,
    maxIterations: params.maxIterations,
    contextDescriptors: buildContextDescriptors({
      state: params.state,
      question: params.question,
      hasImages: params.hasImages,
      previousAssistantAnswerText: params.previousAssistantAnswerText,
    }),
    recentConversationSummary: summarizeConversationHistory(
      params.historyMessages,
    ),
    recentToolLogs: params.toolLogs
      .slice(-MAX_ROUTER_TOOL_LOG_LINES)
      .map((entry) => entry.summary),
    availableTargets: buildAvailableTargetLines(params.state),
    availableTools: toolSpecs.map((spec) => ({
      name: spec.name,
      description: spec.description,
      inputSchema: spec.inputSchema,
      callExample: spec.callExample,
    })),
  };
}

function applyToolResult(
  state: AgentState,
  result: AgentToolExecutionResult,
  call: AgentToolCall,
): boolean {
  const groundingText = sanitizeText(result.groundingText || "").trim();
  let progressed = false;

  if (groundingText) {
    state.contextPrefixBlocks.push(groundingText);
    state.contextPrefixEstimatedTokens += result.estimatedTokens;
    progressed = true;
  }

  if (call.name === "list_papers" && result.retrievedPaperContexts?.length) {
    state.retrievedPaperContexts = result.retrievedPaperContexts;
    state.paperContexts = [...result.retrievedPaperContexts];
    state.recentPaperContexts = [];
    state.conversationMode = "open";
    state.activeContextItem = null;
    progressed = true;
  } else if (call.name === "list_papers") {
    // A list_papers call without follow-up candidates (e.g., count intent) must
    // still reset stale retrieved/selected contexts from prior turns.
    state.retrievedPaperContexts = [];
    state.paperContexts = [];
    state.recentPaperContexts = [];
    state.conversationMode = "open";
    state.activeContextItem = null;
    progressed = true;
  } else if (result.addedPaperContexts.length) {
    state.paperContexts = dedupePaperContexts([
      ...state.paperContexts,
      ...result.addedPaperContexts,
    ]);
    progressed = true;
  }

  return progressed;
}

function buildResult(params: {
  state: AgentState;
  responderPrompt: string;
  promptSource: "file" | "fallback";
  allowPlannerPaperReads: boolean;
  depthAchieved: AgentDepthLevel;
  shouldOfferDeepenCTA: boolean;
}): AgentOrchestratorResult {
  return {
    activeContextItem: params.state.activeContextItem,
    conversationMode: params.state.conversationMode,
    paperContexts: params.state.paperContexts,
    pinnedPaperContexts: params.state.pinnedPaperContexts,
    recentPaperContexts: params.state.recentPaperContexts,
    contextPrefix: params.state.contextPrefixBlocks
      .map((block) => sanitizeText(block).trim())
      .filter(Boolean)
      .join("\n\n---\n\n"),
    responderContext: buildResponderContextBlock({
      responderPrompt: params.responderPrompt,
      promptSource: params.promptSource,
      toolLogs: params.state.toolLogs,
      uiActions: params.state.uiActions,
      shouldOfferDeepenCTA: params.shouldOfferDeepenCTA,
    }),
    allowPlannerPaperReads: params.allowPlannerPaperReads,
    depthAchieved: params.depthAchieved,
    uiActions: params.state.uiActions,
    toolLogs: params.state.toolLogs,
  };
}

export type AgentOrchestratorDeps = {
  runRouterStep: typeof runAgentRouterStep;
  executeTool: typeof executeToolViaBroker;
  loadPromptPack: typeof loadAgentPromptPack;
};

const defaultDeps: AgentOrchestratorDeps = {
  runRouterStep: runAgentRouterStep,
  executeTool: executeToolViaBroker,
  loadPromptPack: loadAgentPromptPack,
};

export function createAgentOrchestratorRunner(
  deps: Partial<AgentOrchestratorDeps> = {},
): (params: AgentOrchestratorParams) => Promise<AgentOrchestratorResult> {
  const resolvedDeps = { ...defaultDeps, ...deps };

  return async function run(
    params: AgentOrchestratorParams,
  ): Promise<AgentOrchestratorResult> {
    const throwIfCancelled = (): void => {
      if (params.signal?.aborted || params.shouldCancel?.()) {
        const err = new Error("Agent retrieval cancelled.");
        (err as { name?: string }).name = "AbortError";
        throw err;
      }
    };

    throwIfCancelled();
    const promptPack = await resolvedDeps.loadPromptPack();

    const state: AgentState = {
      activeContextItem: params.activeContextItem,
      conversationMode: params.conversationMode,
      activePaperContext: resolvePaperContextRefFromAttachment(
        params.activeContextItem,
      ),
      paperContexts: [...params.paperContexts],
      pinnedPaperContexts: [...params.pinnedPaperContexts],
      recentPaperContexts: [...params.recentPaperContexts],
      retrievedPaperContexts: [],
      contextPrefixBlocks: [],
      contextPrefixEstimatedTokens: 0,
      toolLogs: [],
      uiActions: [],
    };

    const rawMaxIterations = Math.floor(Number(params.maxIterations || 0));
    const maxIterations =
      rawMaxIterations > 0 ? rawMaxIterations : DEFAULT_MAX_AGENT_ITERATIONS;

    const hasExistingPaperContexts =
      dedupePaperContexts([
        ...state.paperContexts,
        ...state.pinnedPaperContexts,
        ...state.recentPaperContexts,
      ]).length > 0;

    const retrievalPolicy = deriveRetrievalPolicy({
      question: params.question,
      conversationMode: state.conversationMode,
      hasActivePaperContext: Boolean(state.activePaperContext),
      selectedPaperContextCount: params.paperContexts.length,
      pinnedPaperContextCount: params.pinnedPaperContexts.length,
    });

    if (
      shouldSkipAgent({
        question: params.question,
        libraryID: Number(params.item.libraryID),
        hasActivePaper: Boolean(state.activePaperContext),
        hasExistingPaperContexts,
        hasImages: (params.images?.length || 0) > 0,
      })
    ) {
      return buildResult({
        state,
        responderPrompt: promptPack.responderPrompt,
        promptSource: promptPack.source,
        allowPlannerPaperReads: retrievalPolicy.allowPlannerPaperReads,
        depthAchieved:
          retrievalPolicy.maxDepthAllowed === "deep"
            ? "deep"
            : "metadata",
        shouldOfferDeepenCTA: retrievalPolicy.shouldOfferDeepenCTA,
      });
    }

    throwIfCancelled();
    params.onTrace?.("Planning Zotero retrieval with agent...");
    params.onTrace?.(
      `Retrieval policy: intent=${retrievalPolicy.intent}, maxDepth=${retrievalPolicy.maxDepthAllowed}.`,
    );

    const totalBudget = deriveAvailableContextBudgetTokens(params);
    const brokerState = createAgentToolBrokerState();
    let noProgressStreak = 0;
    let metadataAttempted = false;
    let abstractAttempted = false;
    let latestSufficiency: AgentSufficiency | null = null;
    let depthAchieved: AgentDepthLevel =
      retrievalPolicy.maxDepthAllowed === "deep" ? "deep" : "metadata";
    const previousAssistantAnswerText = derivePreviousAssistantAnswerText(
      params.historyMessages,
    );

    for (let i = 0; i < maxIterations; i += 1) {
      throwIfCancelled();
      const remainingBudget = Math.max(
        0,
        totalBudget - state.contextPrefixEstimatedTokens,
      );

      if (remainingBudget <= 0) {
        params.onTrace?.("Context budget exhausted; stopping retrieval.");
        break;
      }

      if (noProgressStreak >= MAX_NO_PROGRESS_STEPS) {
        params.onTrace?.("No retrieval progress in recent steps; stopping.");
        break;
      }

      if (retrievalPolicy.maxDepthAllowed === "metadata" && metadataAttempted) {
        params.onTrace?.(
          "Metadata stage complete under policy; stopping retrieval.",
        );
        break;
      }

      if (retrievalPolicy.maxDepthAllowed === "abstract") {
        if (abstractAttempted) {
          params.onTrace?.(
            "Abstract stage complete under policy; stopping retrieval.",
          );
          break;
        }
        if (metadataAttempted && latestSufficiency === "high") {
          params.onTrace?.(
            "Metadata stage is already sufficient; stopping retrieval.",
          );
          break;
        }
      }

      const allowedToolNames = buildAllowedToolNames(
        retrievalPolicy.maxDepthAllowed,
      );
      const policyHints = buildPolicyHints({
        intent: retrievalPolicy.intent,
        maxDepthAllowed: retrievalPolicy.maxDepthAllowed,
        metadataAttempted,
        abstractAttempted,
        latestSufficiency,
      });

      const summary = buildRouterSummary({
        state,
        question: params.question,
        iterationIndex: i,
        maxIterations,
        remainingBudgetTokens: remainingBudget,
        historyMessages: params.historyMessages,
        toolLogs: state.toolLogs,
        hasImages: (params.images?.length || 0) > 0,
        libraryID: Number(params.item.libraryID),
        previousAssistantAnswerText,
        policyHints,
        allowedToolNames,
      });

      const decision = await resolvedDeps.runRouterStep({
        summary,
        model: params.model,
        apiBase: params.apiBase,
        apiKey: params.apiKey,
        signal: params.signal,
        promptPack,
      });

      throwIfCancelled();
      if (decision.trace) {
        params.onTrace?.(decision.trace);
      }

      if (decision.decision === "stop") {
        break;
      }

      const policyCall = enforcePolicyOnToolCall({
        call: decision.call,
        maxDepthAllowed: retrievalPolicy.maxDepthAllowed,
        metadataAttempted,
        latestSufficiency,
      });
      if (!policyCall) {
        params.onTrace?.("Skipped tool call due to retrieval depth policy.");
        noProgressStreak += 1;
        continue;
      }

      const toolLabel = formatToolCallLabel(policyCall);
      params.onTrace?.(`Tool call: ${toolLabel}.`);

      const toolTokenCap = computeToolTokenCap(
        totalBudget,
        state,
        maxIterations,
        i,
      );
      if (toolTokenCap <= 0) {
        params.onTrace?.(
          `No remaining context budget for ${toolLabel}; stopping retrieval.`,
        );
        break;
      }

      const outcome = await resolvedDeps.executeTool({
        call: policyCall,
        ctx: buildToolContext(
          params,
          state,
          previousAssistantAnswerText,
          toolTokenCap,
        ),
        state: brokerState,
      });

      const result = outcome.result;
      throwIfCancelled();
      for (const line of result.traceLines) {
        params.onTrace?.(line);
      }

      const toolLog = summarizeToolResult(i + 1, result);
      state.toolLogs.push(toolLog);

      if (policyCall.name === "list_papers") {
        const depth = result.depthAchieved || policyCall.depth || "metadata";
        if (depth === "abstract") {
          abstractAttempted = true;
          depthAchieved = mergeDepthLevel(depthAchieved, "abstract");
        } else {
          metadataAttempted = true;
          depthAchieved = mergeDepthLevel(depthAchieved, "metadata");
        }
        latestSufficiency = result.sufficiency || "medium";
      } else if (isDeepPaperTool(policyCall.name as AgentToolName)) {
        depthAchieved = mergeDepthLevel(depthAchieved, "deep");
      }

      if (outcome.kind === "error") {
        noProgressStreak += 1;
        continue;
      }

      if (outcome.kind === "ui_action") {
        state.uiActions.push(outcome.action);
      }

      const progressed = applyToolResult(state, result, policyCall);
      if (outcome.kind === "ui_action") {
        noProgressStreak = 0;
      } else if (progressed) {
        noProgressStreak = 0;
      } else {
        noProgressStreak += 1;
      }
    }

    return buildResult({
      state,
      responderPrompt: promptPack.responderPrompt,
      promptSource: promptPack.source,
      allowPlannerPaperReads: retrievalPolicy.allowPlannerPaperReads,
      depthAchieved,
      shouldOfferDeepenCTA: retrievalPolicy.shouldOfferDeepenCTA,
    });
  };
}

export const runAgentOrchestrator = createAgentOrchestratorRunner();
