import type { AgentToolCall } from "./Tools/types";
import type { ReasoningConfig } from "../../../utils/llmClient";
import type { PaperContextRef } from "../types";

/** Summary of a completed tool call, recorded in the loop's execution history. */
export type AgentExecutedStep = {
  toolName: string;
  targetLabel: string;
  ok: boolean;
  /** Compact one-liner, e.g. "read_paper_text | Kim et al., 2025 | complete" */
  summary: string;
};

/**
 * The decision returned by `runAgentStep` for one iteration of the ReAct loop.
 * "stop"  → agent has enough grounding to answer.
 * "tool"  → agent wants to execute one more tool call.
 */
export type AgentStepDecision =
  | { type: "stop"; traceLines: string[] }
  | { type: "tool"; call: AgentToolCall; traceLines: string[] };

/** All context provided to `runAgentStep` for one iteration of the loop. */
export type AgentStepContext = {
  question: string;
  conversationMode: "paper" | "open";
  libraryID: number;
  model: string;
  apiBase?: string;
  apiKey?: string;
  reasoning?: ReasoningConfig;
  /** Zero-based index of the current iteration. */
  iterationIndex: number;
  maxIterations: number;
  activePaperContext?: PaperContextRef | null;
  selectedPaperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  /** Papers loaded from the library by a prior list_papers call. */
  retrievedPaperContexts: PaperContextRef[];
  /** History of tool calls already executed this loop. */
  executedSteps: AgentExecutedStep[];
  /** Compact chat-history lines from recent user/assistant turns. */
  historySummaryLines?: string[];
  /** Whether a previous assistant answer is available from chat history. */
  previousAssistantAnswerAvailable?: boolean;
  /** Preview of the latest assistant answer for follow-up write requests. */
  previousAssistantAnswerPreview?: string;
  /** Approximate tokens still available for tool output in this request. */
  remainingBudgetTokens: number;
};
