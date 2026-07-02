export type LibraryChatReadStrategy =
  | "catalog"
  | "abstract_map"
  | "evidence_overview"
  | "deep_synthesis"
  | "quote_verify";

export type LibraryChatAnswerStyle =
  | "enumeration"
  | "concise_overview"
  | "comparison"
  | "evidence_answer"
  | "quote_answer";

export type LibraryChatReadStrategyStopReason =
  | "enough_evidence"
  | "needs_more_specific_query"
  | "budget_limit"
  | "unreadable_sources";

export type LibraryChatReadStrategyDiagnostics = {
  resolvedStrategy: LibraryChatReadStrategy;
  answerStyle: LibraryChatAnswerStyle;
  strategyReason: string;
  papersPlanned: number;
  papersBodyRead: number;
  papersMetadataOnly: number;
  unreadableReasons: string[];
  stopReason: LibraryChatReadStrategyStopReason;
  coverageFrontier: string[];
};

export type LibraryChatCoverageReceipt = {
  text: string;
  resolvedStrategy: LibraryChatReadStrategy;
  answerStyle: LibraryChatAnswerStyle;
  papersPlanned: number;
  papersBodyRead: number;
  papersMetadataOnly: number;
  stopReason: LibraryChatReadStrategyStopReason;
  coverageFrontier: string[];
};

export type LibraryChatReadStrategyInput = {
  query?: string;
  intent?: "enumerate" | "verify" | "summarize";
  depth?: "pool" | "metadata" | "evidence" | "verify";
  paperCount: number;
  scopeType?: "library" | "collection" | "tag" | "mixed" | "items";
  explicitPaperScope?: boolean;
};

export const DEEP_SYNTHESIS_MAX_PAPERS = 25;
export const EVIDENCE_OVERVIEW_MAX_PAPERS = 80;

function normalizeText(value: unknown): string {
  return `${value ?? ""}`.replace(/\s+/g, " ").trim().toLowerCase();
}

function queryLooksLikeQuoteRequest(query: string): boolean {
  return /\b(?:direct\s+quotes?|exact\s+(?:quotes?|wording|passages?)|verbatim|quote\s+the|quotations?|blockquotes?|source\s+wording|original\s+wording)\b/.test(
    query,
  );
}

export function queryLooksLikeBroadSynthesis(query: string): boolean {
  return /\b(?:commonalit(?:y|ies)|common\s+themes?|themes?|synthesi[sz]e|synthesis|overview|summari[sz]e|summary|compare|contrast|similarit(?:y|ies)|differences?|taxonomy|what\s+do\s+(?:these|those|the)\s+papers?\s+(?:say|show|argue)|across\s+(?:these|those|the)\s+papers?)\b/.test(
    query,
  );
}

function answerStyleForQuery(
  query: string,
  intent: LibraryChatReadStrategyInput["intent"],
): LibraryChatAnswerStyle {
  if (queryLooksLikeQuoteRequest(query) || intent === "verify") {
    return "quote_answer";
  }
  if (/\b(?:compare|contrast|similarit(?:y|ies)|differences?)\b/.test(query)) {
    return "comparison";
  }
  if (intent === "enumerate") return "enumeration";
  if (queryLooksLikeBroadSynthesis(query) || intent === "summarize") {
    return "concise_overview";
  }
  return "evidence_answer";
}

export function resolveLibraryChatReadStrategy(
  input: LibraryChatReadStrategyInput,
): Omit<
  LibraryChatReadStrategyDiagnostics,
  | "papersPlanned"
  | "papersBodyRead"
  | "papersMetadataOnly"
  | "unreadableReasons"
  | "stopReason"
  | "coverageFrontier"
> {
  const query = normalizeText(input.query);
  const paperCount = Math.max(0, Math.floor(input.paperCount || 0));
  const answerStyle = answerStyleForQuery(query, input.intent);
  if (
    input.depth === "verify" ||
    input.intent === "verify" ||
    queryLooksLikeQuoteRequest(query)
  ) {
    return {
      resolvedStrategy: "quote_verify",
      answerStyle,
      strategyReason:
        "Exact quote or verification request; expose only verified quote anchors.",
    };
  }
  if (input.depth === "pool") {
    return {
      resolvedStrategy: "catalog",
      answerStyle,
      strategyReason: "Catalog-only retrieval depth was requested.",
    };
  }
  if (input.depth === "metadata") {
    return {
      resolvedStrategy: "abstract_map",
      answerStyle,
      strategyReason: "Metadata retrieval depth was requested.",
    };
  }
  const boundedScope =
    input.explicitPaperScope ||
    input.scopeType === "items" ||
    input.scopeType === "collection" ||
    input.scopeType === "tag" ||
    input.scopeType === "mixed";
  const broadSynthesis =
    input.intent === "summarize" || queryLooksLikeBroadSynthesis(query);
  if (
    boundedScope &&
    broadSynthesis &&
    paperCount > 0 &&
    paperCount <= DEEP_SYNTHESIS_MAX_PAPERS
  ) {
    return {
      resolvedStrategy: "deep_synthesis",
      answerStyle,
      strategyReason:
        "Bounded multi-paper synthesis should read body evidence across every readable paper.",
    };
  }
  if (
    boundedScope &&
    broadSynthesis &&
    paperCount > DEEP_SYNTHESIS_MAX_PAPERS &&
    paperCount <= EVIDENCE_OVERVIEW_MAX_PAPERS
  ) {
    return {
      resolvedStrategy: "evidence_overview",
      answerStyle,
      strategyReason:
        "Medium-sized synthesis should stage body evidence with representatives and a frontier.",
    };
  }
  if (broadSynthesis) {
    return {
      resolvedStrategy: "abstract_map",
      answerStyle,
      strategyReason:
        "Large or unbounded synthesis starts with metadata/abstract mapping and exposes a coverage frontier.",
    };
  }
  return {
    resolvedStrategy: "evidence_overview",
    answerStyle,
    strategyReason:
      "Evidence question should retrieve supporting snippets without forcing quote-card anchors.",
  };
}

export function completeLibraryChatReadStrategyDiagnostics(params: {
  base: ReturnType<typeof resolveLibraryChatReadStrategy>;
  papersPlanned: number;
  papersBodyRead: number;
  papersMetadataOnly: number;
  unreadableReasons?: string[];
  coverageFrontier?: string[];
  stopReason?: LibraryChatReadStrategyStopReason;
}): LibraryChatReadStrategyDiagnostics {
  return {
    ...params.base,
    papersPlanned: Math.max(0, params.papersPlanned),
    papersBodyRead: Math.max(0, params.papersBodyRead),
    papersMetadataOnly: Math.max(0, params.papersMetadataOnly),
    unreadableReasons: params.unreadableReasons || [],
    stopReason: params.stopReason || "enough_evidence",
    coverageFrontier: params.coverageFrontier || [],
  };
}

export function buildLibraryChatCoverageReceipt(
  diagnostics: LibraryChatReadStrategyDiagnostics,
): LibraryChatCoverageReceipt {
  const papersMetadataOnly = Math.max(
    0,
    diagnostics.papersMetadataOnly,
    diagnostics.papersPlanned - diagnostics.papersBodyRead,
  );
  const frontier = Array.from(new Set(diagnostics.coverageFrontier || []));
  const lines = [
    "Reading receipt:",
    `- Strategy: ${diagnostics.resolvedStrategy}`,
    `- Answer style: ${diagnostics.answerStyle}`,
    `- Planned papers: ${diagnostics.papersPlanned}`,
    `- Body evidence read: ${diagnostics.papersBodyRead}`,
    `- Metadata/abstract only: ${papersMetadataOnly}`,
    `- Stop reason: ${diagnostics.stopReason}`,
    `- Coverage frontier: ${
      frontier.length ? frontier.slice(0, 6).join("; ") : "none"
    }`,
  ];
  return {
    text: lines.join("\n"),
    resolvedStrategy: diagnostics.resolvedStrategy,
    answerStyle: diagnostics.answerStyle,
    papersPlanned: diagnostics.papersPlanned,
    papersBodyRead: diagnostics.papersBodyRead,
    papersMetadataOnly,
    stopReason: diagnostics.stopReason,
    coverageFrontier: frontier,
  };
}
