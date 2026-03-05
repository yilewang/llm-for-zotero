import { sanitizeText } from "../textUtils";
import type { AgentToolName } from "./ToolInfra/types";

export type AgentRetrievalIntent =
  | "library_count"
  | "library_listing"
  | "library_thematic_summary"
  | "paper_specific_or_explicit_deep"
  | "unknown";

export type AgentDepthLevel = "metadata" | "abstract" | "deep";
export type AgentSufficiency = "high" | "medium" | "low";

export type AgentRetrievalPolicyDecision = {
  intent: AgentRetrievalIntent;
  maxDepthAllowed: AgentDepthLevel;
  shouldOfferDeepenCTA: boolean;
  allowPlannerPaperReads: boolean;
};

const DEEP_PAPER_TOOLS = new Set<AgentToolName>([
  "read_paper_text",
  "find_claim_evidence",
  "read_references",
  "get_paper_sections",
  "search_paper_content",
]);

function normalizeQuestion(value: string): string {
  return sanitizeText(value || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function hasLibraryReference(question: string): boolean {
  return (
    /\b(?:my|the|this)\s+(?:zotero\s+)?(?:library|collection)\b/.test(
      question,
    ) ||
    /\b(?:in|from|within|across)\s+(?:my|the|this)\s+(?:zotero\s+)?(?:library|collection)\b/.test(
      question,
    ) ||
    /\bzotero\s+library\b/.test(question)
  );
}

function isOpenLibrarySearchQuestion(question: string): boolean {
  return (
    (/\b(?:which|find|show|list|compare|review|search|look for)\b/.test(
      question,
    ) &&
      /\b(?:paper|papers|study|studies|article|articles|author|authors|work|works)\b/.test(
        question,
      )) ||
    /\b(?:my|our)\s+(?:[a-z0-9-]+\s+){0,5}(?:papers?|studies?|articles?)\b/.test(
      question,
    ) ||
    /\b(?:papers?|studies?|articles?)\s+(?:in|from|within)\s+(?:my|our)\b/.test(
      question,
    ) ||
    /\bwhat\s+(?:papers|studies|articles|authors|works)\b/.test(question)
  );
}

export function isLibraryCountQuestion(question: string): boolean {
  const normalized = normalizeQuestion(question);
  if (!normalized) return false;
  return /\b(?:how many|count|number of|total number|how much)\b/.test(
    normalized,
  );
}

export function isLibraryListingQuestion(question: string): boolean {
  const normalized = normalizeQuestion(question);
  if (!normalized) return false;
  if (
    /\b(?:list|show|which|what(?:'s| is) in|display|enumerate)\b/.test(
      normalized,
    )
  ) {
    return true;
  }
  return (
    /\b(?:all|every)\s+(?:papers?|articles?|studies?)\b/.test(normalized) ||
    /\boverview\b/.test(normalized)
  );
}

export function isLibraryThematicSummaryQuestion(question: string): boolean {
  const normalized = normalizeQuestion(question);
  if (!normalized) return false;
  return /\b(?:theme|themes|trend|trends|topic|topics|common|pattern|patterns|summari[sz]e|overview|review|analy[sz]e|insight|insights)\b/.test(
    normalized,
  );
}

export function hasExplicitPaperReference(question: string): boolean {
  const normalized = normalizeQuestion(question);
  if (!normalized) return false;
  return (
    /\bpaper\s*\d+\b/.test(normalized) ||
    /\b(?:first|second|third|fourth|fifth)\s+paper\b/.test(normalized) ||
    /\bretrieved-paper#\d+\b/.test(normalized) ||
    /\b(?:selected|pinned|active)\s+paper\b/.test(normalized)
  );
}

export function hasExplicitDeepSignals(question: string): boolean {
  const normalized = normalizeQuestion(question);
  if (!normalized) return false;
  return (
    /\b(?:read|deep|in[\s-]?depth|analy[sz]e|full text|section|sections|evidence|method(?:s|ology)?|results?|discussion|references?|cite|cites)\b/.test(
      normalized,
    ) || hasExplicitPaperReference(normalized)
  );
}

function classifyIntent(params: {
  question: string;
  conversationMode: "paper" | "open";
  hasUserPaperSelection: boolean;
}): AgentRetrievalIntent {
  const question = normalizeQuestion(params.question);
  if (!question) return "unknown";

  const explicitDeep = hasExplicitDeepSignals(question);
  const libraryScoped =
    hasLibraryReference(question) ||
    isOpenLibrarySearchQuestion(question);

  // Library-level questions should stay library-level unless the user explicitly
  // requests deep/paper-specific analysis.
  if (libraryScoped && !explicitDeep) {
    if (isLibraryCountQuestion(question)) return "library_count";
    if (isLibraryListingQuestion(question)) return "library_listing";
    return "library_thematic_summary";
  }

  if (explicitDeep) {
    return "paper_specific_or_explicit_deep";
  }

  if (params.hasUserPaperSelection || params.conversationMode === "paper") {
    return "paper_specific_or_explicit_deep";
  }

  if (libraryScoped) return "library_thematic_summary";
  return "unknown";
}

export function deriveRetrievalPolicy(params: {
  question: string;
  conversationMode: "paper" | "open";
  hasActivePaperContext: boolean;
  selectedPaperContextCount: number;
  pinnedPaperContextCount: number;
}): AgentRetrievalPolicyDecision {
  const hasUserPaperSelection =
    params.hasActivePaperContext ||
    params.selectedPaperContextCount > 0 ||
    params.pinnedPaperContextCount > 0;
  const intent = classifyIntent({
    question: params.question,
    conversationMode: params.conversationMode,
    hasUserPaperSelection,
  });

  if (intent === "library_count" || intent === "library_listing") {
    return {
      intent,
      maxDepthAllowed: "metadata",
      shouldOfferDeepenCTA: true,
      allowPlannerPaperReads: false,
    };
  }

  if (intent === "library_thematic_summary") {
    return {
      intent,
      maxDepthAllowed: "abstract",
      shouldOfferDeepenCTA: true,
      allowPlannerPaperReads: false,
    };
  }

  if (intent === "paper_specific_or_explicit_deep") {
    return {
      intent,
      maxDepthAllowed: "deep",
      shouldOfferDeepenCTA: false,
      allowPlannerPaperReads: true,
    };
  }

  return {
    intent,
    maxDepthAllowed: "deep",
    shouldOfferDeepenCTA: false,
    allowPlannerPaperReads: true,
  };
}

export function isDeepPaperTool(toolName: AgentToolName): boolean {
  return DEEP_PAPER_TOOLS.has(toolName);
}
