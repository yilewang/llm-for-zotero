import { validateObject } from "../tools/shared";

/** Keys the model is allowed to place directly on a `papers[]` entry. */
export const PAPER_LEVEL_KEYS = new Set([
  "libraryID",
  "itemKey",
  "screeningStatus",
  "criterionResults",
  "decisionReason",
  "finding",
  "evidence",
]);

/** Keys that belong under `finding`, wherever the model wrote them. */
export const FINDING_KEYS = new Set([
  "roles",
  "mainMessage",
  "researchQuestion",
  "method",
  "mechanisms",
  "relevance",
  "relationships",
  "subquestionIds",
  "criterionIds",
  "findings",
  "contradictions",
  "negativeEvidence",
  "limitations",
  "inclusionDecision",
  "confidence",
  "unresolvedQuestions",
  "tier",
  "frameSlots",
  "claims",
  "hooks",
  "candidateLinks",
  "noLinkSeen",
  "questionsRaised",
]);

export const RECORD_PAPER_EXAMPLE = Object.freeze({
  libraryID: 1,
  itemKey: "ABCD1234",
  finding: {
    mainMessage: "One sentence stating the paper's central claim.",
    relevance: "Why it matters for the review question.",
    confidence: "medium",
    frameSlots: {
      question: "What the paper asks.",
      approach: "How the paper answers it (method, evidence type).",
      system: "Population, model system, task or dataset.",
      sq1: "What it contributes to subquestion sq1, or not_reported.",
    },
    claims: [
      {
        statement: "One concrete thing the paper shows.",
        kind: "finding",
        subquestionIds: ["sq1"],
        evidence: { sourceKind: "body", quote: "short supporting phrase" },
      },
    ],
    hooks: { constructs: ["construct"], methods: ["method"] },
    candidateLinks: [
      { target: "1:WXYZ5678", type: "extends", note: "why they relate" },
    ],
  },
});

export type NormalizedRecordPaper = {
  libraryID: number;
  itemKey: string;
  screeningStatus?: string;
  criterionResults?: Record<string, unknown>;
  decisionReason?: string;
  finding?: Record<string, unknown>;
  evidence?: unknown[];
};

/** A minimal valid paper object, appended to every rejection message. */
export function recordPaperExample(): string {
  return `Example: ${JSON.stringify(RECORD_PAPER_EXAMPLE)}`;
}

export function normalizeRecordPaperInput(
  raw: unknown,
  index: number,
): { paper: NormalizedRecordPaper; warnings: string[] } {
  if (!validateObject<Record<string, unknown>>(raw)) {
    throw new Error(
      `papers[${index}] must be an object. ${recordPaperExample()}`,
    );
  }
  const warnings: string[] = [];
  const libraryID = Number(raw.libraryID);
  const itemKey = typeof raw.itemKey === "string" ? raw.itemKey.trim() : "";
  if (!Number.isInteger(libraryID) || libraryID < 1) {
    throw new Error(
      `papers[${index}].libraryID must be a positive integer. ${recordPaperExample()}`,
    );
  }
  if (!itemKey) {
    throw new Error(
      `papers[${index}].itemKey is required. ${recordPaperExample()}`,
    );
  }
  const finding: Record<string, unknown> = {};
  const nested = validateObject<Record<string, unknown>>(raw.finding)
    ? raw.finding
    : undefined;
  if (nested) {
    for (const [key, value] of Object.entries(nested)) {
      if (FINDING_KEYS.has(key)) finding[key] = value;
      else warnings.push(`papers[${index}].finding.${key} was ignored`);
    }
  }
  for (const [key, value] of Object.entries(raw)) {
    if (PAPER_LEVEL_KEYS.has(key)) continue;
    if (FINDING_KEYS.has(key)) {
      // A nested value is the model's more specific intent; never overwrite it.
      if (!(key in finding)) finding[key] = value;
      continue;
    }
    warnings.push(`papers[${index}].${key} was ignored`);
  }
  const hasFinding = nested !== undefined || Object.keys(finding).length > 0;
  return {
    paper: {
      libraryID,
      itemKey,
      ...(typeof raw.screeningStatus === "string"
        ? { screeningStatus: raw.screeningStatus }
        : {}),
      ...(validateObject<Record<string, unknown>>(raw.criterionResults)
        ? { criterionResults: raw.criterionResults }
        : {}),
      ...(typeof raw.decisionReason === "string"
        ? { decisionReason: raw.decisionReason }
        : {}),
      ...(hasFinding ? { finding } : {}),
      ...(Array.isArray(raw.evidence) ? { evidence: raw.evidence } : {}),
    },
    warnings,
  };
}
