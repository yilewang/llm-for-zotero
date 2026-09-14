import type {
  ResearchCandidateLink,
  ResearchClaim,
  ResearchClaimKind,
  ResearchEdge,
  ResearchEdgeStatus,
  ResearchEdgeType,
  ResearchFrame,
  ResearchFrameSlot,
  ResearchNodeCapacity,
  ResearchNodeHooks,
  ResearchOpenQuestion,
  ResearchPaperTier,
  ResearchQualityReport,
  ResearchSynthesisPhase,
} from "./types";

/**
 * Vocabulary and decoders of the research network: edges, open questions,
 * the comparison frame, claims and tiers. Every value the model can supply
 * is checked here once, so the tool boundary and the durable store agree.
 */

export const RESEARCH_EDGE_TYPES: readonly ResearchEdgeType[] = [
  "extends",
  "contradicts",
  "replicates",
  "shares_method",
  "shares_construct",
  "supplies_theory",
  "motivates",
  "applies_to",
  "refines",
];

export const RESEARCH_EDGE_STATUSES: readonly ResearchEdgeStatus[] = [
  "candidate",
  "verified",
  "refuted",
  "tentative",
  "merged",
];

export const RESEARCH_CLAIM_KINDS: readonly ResearchClaimKind[] = [
  "finding",
  "method",
  "mechanism",
  "limitation",
  "theory",
  "context",
];

export const RESEARCH_PAPER_TIERS: readonly ResearchPaperTier[] = [
  "core",
  "supporting",
  "peripheral",
];

export const RESEARCH_SYNTHESIS_PHASES: readonly ResearchSynthesisPhase[] = [
  "nodes",
  "links",
  "verification",
  "structure",
  "writing",
  "complete",
];

/** Edge types whose truth changes the review's argument; always verified. */
export const EDGE_TYPES_REQUIRING_VERIFICATION: ReadonlySet<ResearchEdgeType> =
  new Set(["contradicts"]);

export const CLAIM_EVIDENCE_KINDS = ["body", "abstract", "metadata"] as const;

type Row = Record<string, unknown>;

function object(value: unknown, label: string): Row {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value as Row;
}

function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${label} is required`);
  }
  return value.trim();
}

function optionalText(value: unknown, label: string): string | undefined {
  return value === undefined ? undefined : text(value, label);
}

function strings(value: unknown, label: string): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
  return value.map((entry, index) => text(entry, `${label}[${index}]`));
}

function number(value: unknown, label: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`${label} must be a number`);
  }
  return value;
}

function nonNegativeInteger(value: unknown, label: string): number {
  const parsed = number(value, label);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return parsed;
}

function oneOf<T extends string>(
  value: unknown,
  allowed: readonly T[],
  label: string,
): T {
  if (!allowed.includes(value as T)) {
    throw new Error(`Invalid ${label}: ${String(value)}`);
  }
  return value as T;
}

export function isPaperIdentity(value: unknown): value is string {
  return typeof value === "string" && /^\d+:[A-Za-z0-9]+$/.test(value);
}

function identity(value: unknown, label: string): string {
  if (!isPaperIdentity(value)) {
    throw new Error(`${label} must be a paper identity like 1:ABCD1234`);
  }
  return value;
}

export function decodeResearchFrameSlot(
  value: unknown,
  label = "frame slot",
): ResearchFrameSlot {
  const input = object(value, label);
  return {
    slotId: text(input.slotId, `${label}.slotId`).replace(/\s+/g, "_"),
    name: text(input.name, `${label}.name`),
    description: text(input.description, `${label}.description`),
    kind: oneOf(input.kind, ["identity", "comparison"], `${label}.kind`),
  };
}

export function decodeResearchFrame(value: unknown): ResearchFrame {
  const input = object(value, "research frame");
  if (input.version !== 1) throw new Error("Unsupported research frame");
  if (!Array.isArray(input.slots) || !input.slots.length) {
    throw new Error("A research frame requires at least one slot");
  }
  const slots = input.slots.map((entry, index) =>
    decodeResearchFrameSlot(entry, `frame.slots[${index}]`),
  );
  const ids = new Set<string>();
  for (const slot of slots) {
    if (ids.has(slot.slotId)) {
      throw new Error(`Duplicate frame slot ${slot.slotId}`);
    }
    ids.add(slot.slotId);
  }
  return { version: 1, slots, revisedAt: number(input.revisedAt, "revisedAt") };
}

export function decodeResearchNodeCapacity(
  value: unknown,
): ResearchNodeCapacity {
  const input = object(value, "node capacity");
  return {
    fullNodeCapacity: nonNegativeInteger(
      input.fullNodeCapacity,
      "fullNodeCapacity",
    ),
    linkViewTokens: nonNegativeInteger(input.linkViewTokens, "linkViewTokens"),
    compactCoreTokens: nonNegativeInteger(
      input.compactCoreTokens,
      "compactCoreTokens",
    ),
    compactPeripheralTokens: nonNegativeInteger(
      input.compactPeripheralTokens,
      "compactPeripheralTokens",
    ),
    mandatoryTiering: input.mandatoryTiering === true,
    measuredAt: number(input.measuredAt, "measuredAt"),
  };
}

export function decodeResearchQualityReport(
  value: unknown,
): ResearchQualityReport {
  const input = object(value, "quality report");
  if (input.version !== 1) throw new Error("Unsupported quality report");
  const count = (key: string) => nonNegativeInteger(input[key], key);
  const subquestionClaims: Record<string, number> = {};
  for (const [id, total] of Object.entries(
    object(input.subquestionClaims, "subquestionClaims"),
  )) {
    subquestionClaims[id] = nonNegativeInteger(
      total,
      `subquestionClaims.${id}`,
    );
  }
  return {
    version: 1,
    computedAt: number(input.computedAt, "computedAt"),
    papers: count("papers"),
    nodes: count("nodes"),
    claims: count("claims"),
    claimsWithLocators: count("claimsWithLocators"),
    nodesWithEdges: count("nodesWithEdges"),
    edges: count("edges"),
    edgesVerified: count("edgesVerified"),
    edgesTentative: count("edgesTentative"),
    edgesRefuted: count("edgesRefuted"),
    contradictions: count("contradictions"),
    subquestionClaims,
    themes: count("themes"),
    themesWithEdges: count("themesWithEdges"),
    openQuestions: count("openQuestions"),
    answeredQuestions: count("answeredQuestions"),
    ...(input.crossPaperParagraphs === undefined
      ? {}
      : { crossPaperParagraphs: count("crossPaperParagraphs") }),
    ...(input.crossPaperParagraphsSupported === undefined
      ? {}
      : {
          crossPaperParagraphsSupported: count("crossPaperParagraphsSupported"),
        }),
  };
}

export function decodeResearchClaim(
  value: unknown,
  label = "claim",
): ResearchClaim {
  const input = object(value, label);
  const evidence = object(input.evidence, `${label}.evidence`);
  const pageIndex =
    evidence.pageIndex === undefined
      ? undefined
      : nonNegativeInteger(evidence.pageIndex, `${label}.evidence.pageIndex`);
  return {
    claimId: text(input.claimId, `${label}.claimId`),
    statement: text(input.statement, `${label}.statement`),
    kind: oneOf(input.kind, RESEARCH_CLAIM_KINDS, `${label} claim kind`),
    subquestionIds: strings(input.subquestionIds, `${label}.subquestionIds`),
    evidence: {
      sourceKind: oneOf(
        evidence.sourceKind,
        CLAIM_EVIDENCE_KINDS,
        `${label}.evidence.sourceKind`,
      ),
      ...(pageIndex === undefined ? {} : { pageIndex }),
      ...(evidence.quote === undefined
        ? {}
        : { quote: text(evidence.quote, `${label}.evidence.quote`) }),
      ...(evidence.verified === undefined
        ? {}
        : { verified: evidence.verified === true }),
    },
  };
}

export function decodeResearchNodeHooks(
  value: unknown,
  label = "hooks",
): ResearchNodeHooks {
  const input = object(value, label);
  const list = (key: keyof ResearchNodeHooks) =>
    input[key] === undefined ? [] : strings(input[key], `${label}.${key}`);
  return {
    constructs: list("constructs"),
    methods: list("methods"),
    datasets: list("datasets"),
    populations: list("populations"),
    keyQuantities: list("keyQuantities"),
  };
}

export function decodeResearchCandidateLink(
  value: unknown,
  label = "candidate link",
): ResearchCandidateLink {
  const input = object(value, label);
  return {
    target: identity(input.target, `${label}.target`),
    type: oneOf(input.type, RESEARCH_EDGE_TYPES, `${label} edge type`),
    note: text(input.note, `${label}.note`),
  };
}

export function decodeResearchEdge(value: unknown): ResearchEdge {
  const input = object(value, "research edge");
  if (input.version !== 1) throw new Error("Unsupported research edge version");
  const source = identity(input.source, "edge.source");
  const target = identity(input.target, "edge.target");
  if (source === target) {
    throw new Error("An edge cannot relate a paper to itself");
  }
  const status = oneOf(input.status, RESEARCH_EDGE_STATUSES, "edge status");
  const verificationInput =
    input.verification === undefined
      ? undefined
      : object(input.verification, "edge.verification");
  if ((status === "verified" || status === "refuted") && !verificationInput) {
    throw new Error(`A ${status} edge requires its verification record`);
  }
  const lifecycle = oneOf(
    input.lifecycle ?? "valid",
    ["valid", "invalidated"],
    "edge lifecycle",
  );
  return {
    version: 1,
    edgeId: text(input.edgeId, "edge.edgeId"),
    ...(input.edgeKey === undefined
      ? {}
      : { edgeKey: text(input.edgeKey, "edge.edgeKey") }),
    researchJobId: text(input.researchJobId, "edge.researchJobId"),
    executionId: text(input.executionId, "edge.executionId"),
    parentTaskId: text(input.parentTaskId, "edge.parentTaskId"),
    source,
    target,
    type: oneOf(input.type, RESEARCH_EDGE_TYPES, "edge type"),
    statement: text(input.statement, "edge.statement"),
    sourceClaimIds: strings(input.sourceClaimIds ?? [], "edge.sourceClaimIds"),
    targetClaimIds: strings(input.targetClaimIds ?? [], "edge.targetClaimIds"),
    confidence: oneOf(
      input.confidence,
      ["low", "medium", "high"],
      "edge confidence",
    ),
    requiresVerification: input.requiresVerification === true,
    status,
    ...(verificationInput
      ? {
          verification: {
            evidenceRefs: strings(
              verificationInput.evidenceRefs ?? [],
              "edge.verification.evidenceRefs",
            ),
            ...(verificationInput.note === undefined
              ? {}
              : {
                  note: text(verificationInput.note, "edge.verification.note"),
                }),
            decidedAt: number(
              verificationInput.decidedAt,
              "edge.verification.decidedAt",
            ),
          },
        }
      : {}),
    ...(input.mergedInto === undefined
      ? {}
      : { mergedInto: text(input.mergedInto, "edge.mergedInto") }),
    subquestionIds: strings(input.subquestionIds ?? [], "edge.subquestionIds"),
    ...(input.scopeLineageDigest === undefined
      ? {}
      : {
          scopeLineageDigest: text(
            input.scopeLineageDigest,
            "edge.scopeLineageDigest",
          ),
        }),
    lifecycle,
    ...(input.invalidatedAt === undefined
      ? {}
      : { invalidatedAt: number(input.invalidatedAt, "edge.invalidatedAt") }),
    createdAt: number(input.createdAt, "edge.createdAt"),
    updatedAt: number(input.updatedAt, "edge.updatedAt"),
  };
}

export function decodeResearchOpenQuestion(
  value: unknown,
): ResearchOpenQuestion {
  const input = object(value, "research open question");
  if (input.version !== 1) {
    throw new Error("Unsupported research open question version");
  }
  const scope = object(input.scope, "question.scope");
  const scopeKind = oneOf(
    scope.kind,
    ["subquestion", "edge", "node", "corpus"],
    "question scope",
  );
  const ref = optionalText(scope.ref, "question.scope.ref");
  if (scopeKind !== "corpus" && !ref) {
    throw new Error(`A ${scopeKind} question scope requires ref`);
  }
  const priority = number(input.priority, "question priority");
  if (![1, 2, 3].includes(priority)) {
    throw new Error("Invalid question priority: use 1 (high) to 3 (low)");
  }
  const status = oneOf(
    input.status,
    ["open", "answered", "abandoned"],
    "question status",
  );
  const resolutionInput =
    input.resolution === undefined
      ? undefined
      : object(input.resolution, "question.resolution");
  if (status === "answered" && !resolutionInput) {
    throw new Error("An answered question requires its resolution");
  }
  return {
    version: 1,
    questionId: text(input.questionId, "question.questionId"),
    researchJobId: text(input.researchJobId, "question.researchJobId"),
    executionId: text(input.executionId, "question.executionId"),
    parentTaskId: text(input.parentTaskId, "question.parentTaskId"),
    text: text(input.text, "question.text"),
    scope: { kind: scopeKind, ...(ref ? { ref } : {}) },
    priority: priority as 1 | 2 | 3,
    origin: oneOf(input.origin, ["model", "host_gap"], "question origin"),
    status,
    ...(resolutionInput
      ? {
          resolution: {
            text: text(resolutionInput.text, "question.resolution.text"),
            evidenceRefs: strings(
              resolutionInput.evidenceRefs ?? [],
              "question.resolution.evidenceRefs",
            ),
          },
        }
      : {}),
    ...(input.scopeLineageDigest === undefined
      ? {}
      : {
          scopeLineageDigest: text(
            input.scopeLineageDigest,
            "question.scopeLineageDigest",
          ),
        }),
    lifecycle: oneOf(
      input.lifecycle ?? "valid",
      ["valid", "invalidated"],
      "question lifecycle",
    ),
    ...(input.invalidatedAt === undefined
      ? {}
      : {
          invalidatedAt: number(input.invalidatedAt, "question.invalidatedAt"),
        }),
    createdAt: number(input.createdAt, "question.createdAt"),
    updatedAt: number(input.updatedAt, "question.updatedAt"),
  };
}
