import type { PaperContextRef } from "../../types";

export type ListPapersDepth = "metadata" | "abstract";

export type AgentToolName =
  | "read_paper_text"
  | "find_claim_evidence"
  | "read_references"
  | "list_papers"
  | "get_paper_sections"
  | "search_paper_content"
  | "write_note"
  | "search_internet"
  | "fix_metadata";

export type AgentToolTarget =
  | { scope: "active-paper" }
  | { scope: "selected-paper"; index: number }
  | { scope: "pinned-paper"; index: number }
  | { scope: "recent-paper"; index: number }
  | { scope: "retrieved-paper"; index: number };

export type AgentToolCall = {
  name: AgentToolName;
  /** Required for paper tools; absent for list_papers. */
  target?: AgentToolTarget;
  /**
   * Optional query payload used by query-bearing tools:
   * - list_papers/search_internet/search_paper_content: required by validators when needed
   * - write_note/find_claim_evidence: optional refinement text
   */
  query?: string;
  /** For list_papers: optional number of papers to return (minimum 1 when set). */
  limit?: number;
  /** For list_papers: retrieval depth stage (metadata default, abstract on escalation). */
  depth?: ListPapersDepth;
};

export type ResolvedAgentToolTarget = {
  paperContext: PaperContextRef | null;
  contextItem: Zotero.Item | null;
  targetLabel: string;
  resolvedKey?: string;
  error?: string;
};

export type AgentToolExecutionResult = {
  name: AgentToolName;
  targetLabel: string;
  ok: boolean;
  traceLines: string[];
  groundingText: string;
  addedPaperContexts: PaperContextRef[];
  /**
   * For list_papers: the retrieved papers to be used as retrieved-paper#N
   * targets in subsequent tool calls.  Undefined for paper tools.
   */
  retrievedPaperContexts?: PaperContextRef[];
  /** Coarse retrieval depth represented by this tool output. */
  depthAchieved?: "metadata" | "abstract" | "deep";
  /** Coarse answer sufficiency estimate for the current question. */
  sufficiency?: "high" | "medium" | "low";
  estimatedTokens: number;
  truncated: boolean;
};

export type AgentToolExecutionContext = {
  question: string;
  /** Latest non-empty assistant answer from chat history, if available. */
  previousAssistantAnswerText?: string;
  libraryID: number;
  /**
   * The Zotero item ID of the panel/conversation item (may be a global portal
   * item in open-chat mode, NOT the paper being acted on).  Used as the key
   * for pending proposal maps so refreshChat can find them via item.id.
   */
  panelItemId: number;
  conversationMode: "paper" | "open";
  activePaperContext?: PaperContextRef | null;
  selectedPaperContexts: PaperContextRef[];
  pinnedPaperContexts: PaperContextRef[];
  recentPaperContexts: PaperContextRef[];
  retrievedPaperContexts: PaperContextRef[];
  toolTokenCap?: number;
  availableContextBudgetTokens?: number;
  apiBase?: string;
  apiKey?: string;
  model?: string;
  onTrace?: (line: string) => void;
  onStatus?: (line: string) => void;
};

export type AgentToolExecutorState = {
  executedCallKeys: Set<string>;
  totalEstimatedTokens: number;
  executedCallCount: number;
};
