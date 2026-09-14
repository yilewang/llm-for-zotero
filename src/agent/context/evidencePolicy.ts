import type { AgentCoverageEntry } from "./coverageLedger";
import type { AgentRuntimeRequest } from "../types";

/**
 * One owner for "how much source evidence does this turn need, and how much
 * does it already hold". The prompt's reading rule and the per-read stop
 * guidance are both rendered from this policy so they can never disagree.
 *
 * The classifier decides the kind of support an acceptable answer needs
 * (source + coverage). The host decides what is already held: chunk- or
 * page-verified selection context in this turn, and body-text reads from
 * earlier turns of the same conversation. Retrieval is required only when the
 * requirement is not covered by held evidence, or when coverage is exhaustive.
 */

export type EvidenceSource =
  | "provided_context"
  | "metadata"
  | "document_text"
  | "rendered_pages";

export type EvidenceCoverage = "overview" | "targeted" | "exhaustive";

export type HeldEvidenceEntry = {
  kind: "selection_anchor" | "prior_read";
  label: string;
};

export type TurnEvidencePolicy = {
  source: Exclude<EvidenceSource, "metadata">;
  coverage: EvidenceCoverage;
  held: HeldEvidenceEntry[];
  /** True when the model must retrieve before answering. */
  retrievalRequired: boolean;
  /** Reads in this turn after which the model is told to answer with what it has. */
  readBudget: number;
};

export type ReadStopPolicy = Pick<
  TurnEvidencePolicy,
  "coverage" | "readBudget"
>;

export type ReadStopRecommendation =
  | "continue_plan"
  | "answer_now"
  | "answer_or_self_check"
  | "name_a_specific_missing_dimension"
  | "answer_with_source_limitation";

export type ReadStopGuidance = {
  recommendation: ReadStopRecommendation;
  reason: string;
};

const READ_BUDGET_BY_COVERAGE: Record<EvidenceCoverage, number> = {
  overview: 1,
  targeted: 2,
  exhaustive: Number.POSITIVE_INFINITY,
};

const BODY_TEXT_SOURCE_KINDS = new Set<AgentCoverageEntry["sourceKind"]>([
  "zotero_fulltext",
  "mineru",
  "embedding_retrieval",
  "attachment_text",
]);
const BODY_TEXT_GRANULARITIES = new Set<AgentCoverageEntry["granularity"]>([
  "overview",
  "section",
  "passage",
]);

function selectionAnchorsHeld(
  request: AgentRuntimeRequest,
): HeldEvidenceEntry[] {
  const contexts = request.selectedTextContexts || [];
  return (request.resolvedSelectedTextAnchors || []).flatMap((anchor) => {
    const context = contexts[anchor.contextIndex];
    if (!context || context.source !== "pdf") return [];
    if (anchor.resolution === "locator-only" || !anchor.contextText?.trim()) {
      return [];
    }
    const pageLabel =
      (context.pageLabel || anchor.pageLabel || "").trim() ||
      (anchor.pageIndex !== undefined ? String(anchor.pageIndex + 1) : "");
    const verification =
      anchor.resolution === "chunks" ? "chunk-verified" : "page-verified";
    return [
      {
        kind: "selection_anchor" as const,
        label: `selected text ${anchor.contextIndex + 1}${
          pageLabel ? ` (page ${pageLabel})` : ""
        } with its local source context, ${verification}`,
      },
    ];
  });
}

function priorReadsHeld(
  source: TurnEvidencePolicy["source"],
  entries: readonly AgentCoverageEntry[],
): HeldEvidenceEntry[] {
  return entries.flatMap((entry) => {
    if (entry.coverage === "listed") return [];
    const matches =
      source === "rendered_pages"
        ? entry.sourceKind === "pdf_visual"
        : BODY_TEXT_SOURCE_KINDS.has(entry.sourceKind) &&
          BODY_TEXT_GRANULARITIES.has(entry.granularity);
    if (!matches) return [];
    const resource = entry.resourceLabel
      ? `${entry.resourceLabel} [${entry.resourceKey}]`
      : entry.resourceKey;
    const topic = entry.topic ? ` topic "${entry.topic}"` : "";
    return [
      {
        kind: "prior_read" as const,
        label: `prior read: ${resource} ${entry.coverage} ${entry.granularity}${topic}`,
      },
    ];
  });
}

export function resolveTurnEvidencePolicy(
  request: AgentRuntimeRequest,
  options: { priorCoverage?: readonly AgentCoverageEntry[] } = {},
): TurnEvidencePolicy | null {
  // An approved plan owns reading during execution: its tasks, investigation
  // contract, and host reading manifest decide depth, grouping, and when
  // reading stops. The chat-turn classifier must not add a second owner.
  if (request.planContext?.phase === "executing") return null;
  const reading = request.classifiedIntent?.semantic?.reading;
  if (!reading || reading.source === "metadata") return null;
  const coverage = reading.coverage;
  const readBudget = READ_BUDGET_BY_COVERAGE[coverage];
  if (reading.source === "provided_context") {
    return {
      source: "provided_context",
      coverage,
      held: [],
      retrievalRequired: false,
      readBudget,
    };
  }
  const held = [
    ...selectionAnchorsHeld(request),
    ...priorReadsHeld(reading.source, options.priorCoverage || []),
  ];
  return {
    source: reading.source,
    coverage,
    held,
    retrievalRequired: coverage === "exhaustive" || held.length === 0,
    readBudget,
  };
}

function paperReadMode(policy: TurnEvidencePolicy): string {
  if (policy.source === "rendered_pages") return "visual";
  return policy.coverage === "exhaustive" ? "full" : policy.coverage;
}

export function renderTurnReadingRule(policy: TurnEvidencePolicy): string {
  if (policy.source === "provided_context") {
    return "TURN RULE: Use the provided context for this task; no source-document retrieval is required.";
  }
  const mode = paperReadMode(policy);
  const heldLines = policy.held.map((entry) => `- ${entry.label}`).join("\n");
  if (policy.coverage === "exhaustive") {
    return [
      `TURN RULE: The shared reading intent requires ${policy.source} evidence at exhaustive coverage. Use paper_read mode '${mode}' on the resolved source boundary. Resource availability does not expand that boundary. Preserve coverage evidence and disclose partial or unreadable sources.`,
      heldLines
        ? `Already held context does not satisfy exhaustive coverage:\n${heldLines}`
        : "",
    ]
      .filter(Boolean)
      .join("\n");
  }
  if (!policy.held.length) {
    return `TURN RULE: The shared reading intent requires ${policy.source} evidence at ${policy.coverage} coverage. Use paper_read mode '${mode}' on the resolved source boundary. Resource availability does not expand that boundary. Preserve coverage evidence and disclose partial or unreadable sources.`;
  }
  return [
    `TURN RULE: Support needed: ${policy.source} at ${policy.coverage} coverage.`,
    `Already held (host-verified):\n${heldLines}`,
    `Answer from the held context when it supports your explanation. Call paper_read mode '${mode}' on the resolved source boundary only for a specific claim in your draft that the held context does not support, and disclose partial or unreadable sources.`,
  ].join("\n");
}

export function resolveReadStopGuidance(
  policy: ReadStopPolicy,
  state: {
    frontier: "advanced" | "unchanged" | "unavailable";
    readsThisTurn: number;
  },
): ReadStopGuidance {
  if (state.frontier === "unavailable") {
    return {
      recommendation: "answer_with_source_limitation",
      reason:
        "The requested textual source was unavailable. Give the best supported answer and disclose the source limitation.",
    };
  }
  if (policy.coverage === "exhaustive") {
    return state.frontier === "advanced"
      ? {
          recommendation: "answer_or_self_check",
          reason:
            "New source occurrences were delivered. Evaluate the accumulated evidence and either answer or identify one concrete missing dimension.",
        }
      : {
          recommendation: "name_a_specific_missing_dimension",
          reason:
            "This read added no new source occurrence. Do not repeat it; retrieve again only for a specifically named unresolved method, result, qualification, section, or comparison dimension.",
        };
  }
  if (state.frontier === "unchanged") {
    return {
      recommendation: "answer_now",
      reason:
        "This read added no new source text. Answer now from the evidence already held and delivered; do not retrieve again for this question.",
    };
  }
  if (state.readsThisTurn >= policy.readBudget) {
    return {
      recommendation: "answer_now",
      reason: `The ${policy.coverage} read budget for this turn (${policy.readBudget}) is used. Answer now from the held and delivered evidence and disclose any claim it does not support instead of retrieving again.`,
    };
  }
  return {
    recommendation: "answer_or_self_check",
    reason:
      "New source text was delivered. Answer from the held and delivered evidence. Retrieve again only for one specifically named claim in your draft that this evidence does not support.",
  };
}
