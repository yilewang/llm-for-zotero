import { ToolInputRejection } from "../tools/execution/failure";
import type { TaskEvidence } from "../plans/types";
import { validateObject } from "../tools/shared";
import {
  EDGE_TYPES_REQUIRING_VERIFICATION,
  RESEARCH_EDGE_STATUSES,
  RESEARCH_EDGE_TYPES,
  RESEARCH_SYNTHESIS_PHASES,
} from "./graphSchema";
import { string } from "./recordValidation";
import { commitResearchRecords } from "./stages";
import {
  listPaperFindings,
  listResearchEdges,
  listResearchOpenQuestions,
  listThemeFindings,
  saveResearchEdge,
  saveResearchJob,
  saveResearchOpenQuestion,
} from "./store";
import type {
  PaperFinding,
  ResearchCorpusItem,
  ResearchEdge,
  ResearchEdgeStatus,
  ResearchEdgeType,
  ResearchFindingConfidence,
  ResearchJob,
  ResearchOpenQuestion,
  ResearchSynthesisPhase,
  ThemeFinding,
} from "./types";

/**
 * The bounded loop after every node is durable: an explicit typed edge list,
 * host-ranked verification work the model chooses from, open questions, and
 * host-validated phase transitions with stop rules. Every accepted call is
 * durable; the host never invents an edge on the model's behalf.
 */

const PHASE_INDEX = new Map(
  RESEARCH_SYNTHESIS_PHASES.map((phase, index) => [phase, index]),
);

export function currentPhase(job: ResearchJob): ResearchSynthesisPhase {
  return job.synthesisPhase || "nodes";
}

function requirePhase(
  job: ResearchJob,
  allowed: readonly ResearchSynthesisPhase[],
  operation: string,
): void {
  const phase = currentPhase(job);
  if (!allowed.includes(phase)) {
    throw new ToolInputRejection(
      `${operation} is available in the ${allowed.join(", ")} phase${
        allowed.length > 1 ? "s" : ""
      }; the loop is in the ${phase} phase${
        phase === "nodes"
          ? " (record a node for every manifest paper first)"
          : ""
      }`,
    );
  }
}

const CONFIDENCES: readonly ResearchFindingConfidence[] = [
  "low",
  "medium",
  "high",
];

function identityOf(raw: Record<string, unknown>, key: string, label: string) {
  const direct = raw[key];
  if (typeof direct === "string" && direct.trim()) return direct.trim();
  const nested = validateObject<Record<string, unknown>>(direct) ? direct : raw;
  const libraryID = Number(nested[`${key}LibraryID`] ?? nested.libraryID);
  const itemKey = nested[`${key}ItemKey`] ?? nested.itemKey;
  if (Number.isInteger(libraryID) && typeof itemKey === "string" && itemKey) {
    return `${libraryID}:${itemKey.trim()}`;
  }
  throw new ToolInputRejection(
    `${label} must be a paper identity like 1:ABCD1234`,
  );
}

export type RecordedEdgeSummary = Pick<
  ResearchEdge,
  | "edgeId"
  | "edgeKey"
  | "source"
  | "target"
  | "type"
  | "statement"
  | "status"
  | "confidence"
  | "requiresVerification"
>;

export async function recordResearchEdges(params: {
  job: ResearchJob;
  edges: unknown[];
  corpusByKey: ReadonlyMap<string, ResearchCorpusItem>;
  now?: number;
}): Promise<{ edges: RecordedEdgeSummary[]; warnings: string[] }> {
  requirePhase(
    params.job,
    ["links", "verification", "structure", "writing"],
    "record_edges",
  );
  const now = params.now ?? Date.now();
  const findings = await listPaperFindings(params.job.researchJobId);
  const nodeByIdentity = new Map(
    findings.map((finding) => [
      `${finding.libraryID}:${finding.itemKey}`,
      finding,
    ]),
  );
  const existing = await listResearchEdges(params.job.researchJobId);
  const byPair = new Map(
    existing.map((edge) => [
      `${edge.source}|${edge.target}|${edge.type}`,
      edge,
    ]),
  );
  const byKey = new Map(
    existing
      .filter((edge) => edge.edgeKey)
      .map((edge) => [edge.edgeKey!, edge]),
  );
  let nextOrdinal = existing.length + 1;
  const warnings: string[] = [];
  const writes: ResearchEdge[] = [];
  for (let index = 0; index < params.edges.length; index += 1) {
    const raw = params.edges[index];
    if (!validateObject<Record<string, unknown>>(raw)) {
      throw new ToolInputRejection(`edges[${index}] must be an object`);
    }
    const label = `edges[${index}]`;
    const source = identityOf(raw, "source", `${label}.source`);
    const target = identityOf(raw, "target", `${label}.target`);
    if (source === target) {
      throw new ToolInputRejection(
        `${label} cannot relate ${source} to itself`,
      );
    }
    for (const end of [source, target]) {
      if (!params.corpusByKey.has(end)) {
        throw new ToolInputRejection(
          `${label} names ${end}, which is outside the frozen corpus`,
        );
      }
      if (!nodeByIdentity.has(end)) {
        throw new ToolInputRejection(
          `${label} names ${end}, which has no durable node yet; record its node before linking it`,
        );
      }
    }
    if (!RESEARCH_EDGE_TYPES.includes(raw.type as ResearchEdgeType)) {
      throw new ToolInputRejection(
        `${label}.type must be one of ${RESEARCH_EDGE_TYPES.join(", ")}`,
      );
    }
    const type = raw.type as ResearchEdgeType;
    const statement = string(raw.statement, `${label}.statement`);
    const confidence = CONFIDENCES.includes(
      raw.confidence as ResearchFindingConfidence,
    )
      ? (raw.confidence as ResearchFindingConfidence)
      : undefined;
    if (!confidence) {
      throw new ToolInputRejection(
        `${label}.confidence must be low, medium, or high`,
      );
    }
    const claimIds = (
      value: unknown,
      node: PaperFinding,
      field: string,
    ): string[] => {
      if (value === undefined) return [];
      if (!Array.isArray(value))
        throw new ToolInputRejection(`${label}.${field} must be an array`);
      const known = new Set((node.claims || []).map((claim) => claim.claimId));
      return value.map((entry) => {
        const claimId = string(entry, `${label}.${field}`);
        if (known.size && !known.has(claimId)) {
          throw new ToolInputRejection(
            `${label}.${field} names claim ${claimId}, which ${node.libraryID}:${node.itemKey} does not have (known: ${[...known].join(", ")})`,
          );
        }
        return claimId;
      });
    };
    const sourceNode = nodeByIdentity.get(source)!;
    const targetNode = nodeByIdentity.get(target)!;
    const sourceClaimIds = claimIds(
      raw.sourceClaimIds,
      sourceNode,
      "sourceClaimIds",
    );
    const targetClaimIds = claimIds(
      raw.targetClaimIds,
      targetNode,
      "targetClaimIds",
    );
    const claimsOf = (node: PaperFinding, ids: readonly string[]) =>
      (node.claims || []).filter((claim) => ids.includes(claim.claimId));
    const subquestionIds = [
      ...new Set([
        ...claimsOf(sourceNode, sourceClaimIds).flatMap(
          (c) => c.subquestionIds,
        ),
        ...claimsOf(targetNode, targetClaimIds).flatMap(
          (c) => c.subquestionIds,
        ),
      ]),
    ];
    const requiresVerification =
      EDGE_TYPES_REQUIRING_VERIFICATION.has(type) ||
      raw.requiresVerification === true;
    const edgeKey =
      typeof raw.edgeKey === "string" && raw.edgeKey.trim()
        ? raw.edgeKey.trim()
        : undefined;
    const prior =
      (edgeKey && byKey.get(edgeKey)) ||
      byPair.get(`${source}|${target}|${type}`);
    const edge: ResearchEdge = prior
      ? {
          ...prior,
          ...(edgeKey ? { edgeKey } : {}),
          statement,
          sourceClaimIds,
          targetClaimIds,
          confidence,
          requiresVerification:
            prior.requiresVerification || requiresVerification,
          subquestionIds,
          updatedAt: now,
        }
      : {
          version: 1,
          edgeId: `${params.job.researchJobId}:edge:${nextOrdinal++}`,
          ...(edgeKey ? { edgeKey } : {}),
          researchJobId: params.job.researchJobId,
          executionId: params.job.executionId,
          parentTaskId: params.job.parentTaskId,
          source,
          target,
          type,
          statement,
          sourceClaimIds,
          targetClaimIds,
          confidence,
          requiresVerification,
          status: "candidate",
          subquestionIds,
          scopeLineageDigest: params.job.scopeLineageDigest,
          lifecycle: "valid",
          createdAt: now,
          updatedAt: now,
        };
    if (prior) warnings.push(`${label} updated existing edge ${prior.edgeId}`);
    byPair.set(`${source}|${target}|${type}`, edge);
    if (edgeKey) byKey.set(edgeKey, edge);
    writes.push(edge);
  }
  await commitResearchRecords(params.job, async () => {
    for (const edge of writes) await saveResearchEdge(edge);
  });
  return {
    edges: writes.map(
      ({
        edgeId,
        edgeKey,
        source,
        target,
        type,
        statement,
        status,
        confidence,
        requiresVerification,
      }) => ({
        edgeId,
        ...(edgeKey ? { edgeKey } : {}),
        source,
        target,
        type,
        statement,
        status,
        confidence,
        requiresVerification,
      }),
    ),
    warnings,
  };
}

/**
 * Body observations from a targeted read of either paper of the pair issued
 * after the edge was recorded: the only evidence that verifies or refutes. A
 * page locator counts as targeted evidence too (page reads name their page).
 */
export function verificationObservations(params: {
  edge: ResearchEdge;
  taskEvidence: readonly TaskEvidence[];
}): string[] {
  const ids: string[] = [];
  for (const entry of params.taskEvidence) {
    if (
      entry.kind !== "verified_read" ||
      !entry.verified ||
      entry.payload?.type !== "verified_read" ||
      entry.createdAt <= params.edge.createdAt
    ) {
      continue;
    }
    for (const observation of entry.payload.observations || []) {
      const identity = `${observation.libraryID}:${observation.itemKey}`;
      if (
        (identity === params.edge.source || identity === params.edge.target) &&
        observation.capabilities.includes("body") &&
        (observation.readMode === "targeted" ||
          observation.pageIndex !== undefined)
      ) {
        ids.push(observation.observationId);
      }
    }
  }
  return [...new Set(ids)];
}

export async function updateResearchEdges(params: {
  job: ResearchJob;
  updates: unknown[];
  taskEvidence: readonly TaskEvidence[];
  now?: number;
}): Promise<{ edges: RecordedEdgeSummary[] }> {
  requirePhase(
    params.job,
    ["verification", "structure", "writing"],
    "update_edges",
  );
  const now = params.now ?? Date.now();
  const existing = await listResearchEdges(params.job.researchJobId);
  const byId = new Map(existing.map((edge) => [edge.edgeId, edge]));
  const writes: ResearchEdge[] = [];
  for (let index = 0; index < params.updates.length; index += 1) {
    const raw = params.updates[index];
    if (!validateObject<Record<string, unknown>>(raw)) {
      throw new ToolInputRejection(`edges[${index}] must be an object`);
    }
    const label = `edges[${index}]`;
    const edgeId = string(raw.edgeId, `${label}.edgeId`);
    const edge = byId.get(edgeId);
    if (!edge)
      throw new ToolInputRejection(`${label} names unknown edge ${edgeId}`);
    const status = raw.status as ResearchEdgeStatus | undefined;
    if (status !== undefined && !RESEARCH_EDGE_STATUSES.includes(status)) {
      throw new ToolInputRejection(
        `${label}.status must be one of ${RESEARCH_EDGE_STATUSES.join(", ")}`,
      );
    }
    const note =
      typeof raw.note === "string" && raw.note.trim()
        ? raw.note.trim()
        : undefined;
    let next: ResearchEdge = {
      ...edge,
      ...(typeof raw.statement === "string" && raw.statement.trim()
        ? { statement: raw.statement.trim() }
        : {}),
      ...(CONFIDENCES.includes(raw.confidence as ResearchFindingConfidence)
        ? { confidence: raw.confidence as ResearchFindingConfidence }
        : {}),
      updatedAt: now,
    };
    if (status === "verified" || status === "refuted") {
      const evidenceRefs = verificationObservations({
        edge,
        taskEvidence: params.taskEvidence,
      });
      if (!evidenceRefs.length) {
        throw new ToolInputRejection(
          `${label}: ${status} requires a targeted paper_read of ${edge.source} or ${edge.target} issued after the edge was recorded; read the pair with a specific query, then decide`,
        );
      }
      next = {
        ...next,
        status,
        verification: {
          evidenceRefs,
          ...(note ? { note } : {}),
          decidedAt: now,
        },
      };
    } else if (status === "tentative") {
      if (!note) {
        throw new ToolInputRejection(
          `${label}: a tentative edge needs a note saying why it stays unverified`,
        );
      }
      next = {
        ...next,
        status,
        verification: { evidenceRefs: [], note, decidedAt: now },
      };
    } else if (status === "merged") {
      const mergedInto = string(raw.mergedInto, `${label}.mergedInto`);
      if (!byId.has(mergedInto) || mergedInto === edgeId) {
        throw new ToolInputRejection(
          `${label}.mergedInto must name another existing edge`,
        );
      }
      next = { ...next, status, mergedInto };
    } else if (status === "candidate") {
      next = { ...next, status, verification: undefined };
    }
    byId.set(edgeId, next);
    writes.push(next);
  }
  await commitResearchRecords(params.job, async () => {
    for (const edge of writes) await saveResearchEdge(edge);
  });
  return {
    edges: writes.map(
      ({
        edgeId,
        edgeKey,
        source,
        target,
        type,
        statement,
        status,
        confidence,
        requiresVerification,
      }) => ({
        edgeId,
        ...(edgeKey ? { edgeKey } : {}),
        source,
        target,
        type,
        statement,
        status,
        confidence,
        requiresVerification,
      }),
    ),
  };
}

const DEFAULT_PRIORITY: Record<
  ResearchOpenQuestion["scope"]["kind"],
  1 | 2 | 3
> = { edge: 1, subquestion: 2, node: 2, corpus: 3 };

export async function recordResearchQuestions(params: {
  job: ResearchJob;
  questions: unknown[];
  corpusByKey: ReadonlyMap<string, ResearchCorpusItem>;
  subquestionIds: ReadonlySet<string>;
  origin?: ResearchOpenQuestion["origin"];
  now?: number;
}): Promise<ResearchOpenQuestion[]> {
  requirePhase(
    params.job,
    ["links", "verification", "structure", "writing"],
    "record_questions",
  );
  const now = params.now ?? Date.now();
  const edges = await listResearchEdges(params.job.researchJobId);
  const edgeIds = new Set(edges.map((edge) => edge.edgeId));
  const existing = await listResearchOpenQuestions(params.job.researchJobId, {
    includeInvalidated: true,
  });
  let nextOrdinal = existing.length + 1;
  const writes: ResearchOpenQuestion[] = [];
  for (let index = 0; index < params.questions.length; index += 1) {
    const raw = params.questions[index];
    if (!validateObject<Record<string, unknown>>(raw)) {
      throw new ToolInputRejection(`questions[${index}] must be an object`);
    }
    const label = `questions[${index}]`;
    const text = string(raw.text, `${label}.text`);
    const scopeInput = validateObject<Record<string, unknown>>(raw.scope)
      ? raw.scope
      : { kind: "corpus" };
    const kind = scopeInput.kind as ResearchOpenQuestion["scope"]["kind"];
    if (!["subquestion", "edge", "node", "corpus"].includes(String(kind))) {
      throw new ToolInputRejection(
        `${label}.scope.kind must be subquestion, edge, node, or corpus`,
      );
    }
    const ref =
      typeof scopeInput.ref === "string" && scopeInput.ref.trim()
        ? scopeInput.ref.trim()
        : undefined;
    if (kind === "edge" && (!ref || !edgeIds.has(ref))) {
      throw new ToolInputRejection(
        `${label}.scope.ref must name an existing edge`,
      );
    }
    if (kind === "node" && (!ref || !params.corpusByKey.has(ref))) {
      throw new ToolInputRejection(
        `${label}.scope.ref must name a corpus paper identity`,
      );
    }
    if (kind === "subquestion" && (!ref || !params.subquestionIds.has(ref))) {
      throw new ToolInputRejection(
        `${label}.scope.ref must name an approved subquestion`,
      );
    }
    const priority =
      raw.priority === undefined
        ? DEFAULT_PRIORITY[kind]
        : ([1, 2, 3] as const).find((value) => value === Number(raw.priority));
    if (!priority) {
      throw new ToolInputRejection(
        `${label}.priority must be 1 (high), 2, or 3 (low)`,
      );
    }
    writes.push({
      version: 1,
      questionId: `${params.job.researchJobId}:question:${nextOrdinal++}`,
      researchJobId: params.job.researchJobId,
      executionId: params.job.executionId,
      parentTaskId: params.job.parentTaskId,
      text,
      scope: { kind, ...(ref ? { ref } : {}) },
      priority,
      origin: params.origin || "model",
      status: "open",
      scopeLineageDigest: params.job.scopeLineageDigest,
      lifecycle: "valid",
      createdAt: now,
      updatedAt: now,
    });
  }
  await commitResearchRecords(params.job, async () => {
    for (const question of writes) await saveResearchOpenQuestion(question);
  });
  return writes;
}

export async function resolveResearchQuestions(params: {
  job: ResearchJob;
  resolutions: unknown[];
  now?: number;
}): Promise<ResearchOpenQuestion[]> {
  requirePhase(
    params.job,
    ["links", "verification", "structure", "writing"],
    "resolve_questions",
  );
  const now = params.now ?? Date.now();
  const existing = await listResearchOpenQuestions(params.job.researchJobId);
  const byId = new Map(
    existing.map((question) => [question.questionId, question]),
  );
  const writes: ResearchOpenQuestion[] = [];
  for (let index = 0; index < params.resolutions.length; index += 1) {
    const raw = params.resolutions[index];
    if (!validateObject<Record<string, unknown>>(raw)) {
      throw new ToolInputRejection(`questions[${index}] must be an object`);
    }
    const label = `questions[${index}]`;
    const questionId = string(raw.questionId, `${label}.questionId`);
    const question = byId.get(questionId);
    if (!question)
      throw new ToolInputRejection(
        `${label} names unknown question ${questionId}`,
      );
    const status = raw.status;
    if (status !== "answered" && status !== "abandoned") {
      throw new ToolInputRejection(
        `${label}.status must be answered or abandoned`,
      );
    }
    const text = string(raw.resolution, `${label}.resolution`);
    const evidenceRefs = Array.isArray(raw.evidenceRefs)
      ? raw.evidenceRefs.map((entry) => string(entry, `${label}.evidenceRefs`))
      : [];
    writes.push({
      ...question,
      status,
      resolution: { text, evidenceRefs },
      updatedAt: now,
    });
  }
  await commitResearchRecords(params.job, async () => {
    for (const question of writes) await saveResearchOpenQuestion(question);
  });
  return writes;
}

export type WorkCandidate =
  | Readonly<{
      kind: "verify_edge";
      edgeId: string;
      source: string;
      target: string;
      type: ResearchEdgeType;
      statement: string;
      confidence: ResearchFindingConfidence;
      required: boolean;
      suggestedQuery: string;
      action: string;
    }>
  | Readonly<{
      kind: "answer_question";
      questionId: string;
      text: string;
      priority: 1 | 2 | 3;
      targets: readonly string[];
      action: string;
    }>;

const TYPE_WEIGHT: Record<ResearchEdgeType, number> = {
  contradicts: 5,
  refines: 3,
  replicates: 3,
  extends: 3,
  supplies_theory: 2,
  applies_to: 2,
  motivates: 1,
  shares_method: 1,
  shares_construct: 1,
};
const CONFIDENCE_WEIGHT: Record<ResearchFindingConfidence, number> = {
  low: 3,
  medium: 2,
  high: 1,
};

/** Host-ranked candidates for the verification phase; the model chooses. */
export function rankVerificationWork(params: {
  edges: readonly ResearchEdge[];
  questions: readonly ResearchOpenQuestion[];
  corpus: readonly ResearchCorpusItem[];
}): WorkCandidate[] {
  const tierOf = new Map(
    params.corpus.map((item) => [
      `${item.libraryID}:${item.itemKey}`,
      item.tier || "core",
    ]),
  );
  const edgeCandidates = params.edges
    .filter((edge) => edge.lifecycle === "valid" && edge.status === "candidate")
    .map((edge) => {
      const coreBonus =
        tierOf.get(edge.source) === "core" && tierOf.get(edge.target) === "core"
          ? 2
          : 1;
      return {
        edge,
        score:
          TYPE_WEIGHT[edge.type] *
          CONFIDENCE_WEIGHT[edge.confidence] *
          coreBonus *
          (edge.requiresVerification ? 4 : 1),
      };
    })
    .sort(
      (left, right) =>
        right.score - left.score || left.edge.createdAt - right.edge.createdAt,
    )
    .map<WorkCandidate>(({ edge }) => ({
      kind: "verify_edge",
      edgeId: edge.edgeId,
      source: edge.source,
      target: edge.target,
      type: edge.type,
      statement: edge.statement,
      confidence: edge.confidence,
      required: edge.requiresVerification,
      suggestedQuery: edge.statement,
      action: `paper_read mode 'targeted' on ${edge.source} and ${edge.target} with a query about the specific claims, then update_edges {edgeId:'${edge.edgeId}', status:'verified'|'refuted'|'tentative', note}`,
    }));
  const questionCandidates = params.questions
    .filter(
      (question) =>
        question.lifecycle === "valid" && question.status === "open",
    )
    .sort(
      (left, right) =>
        left.priority - right.priority || left.createdAt - right.createdAt,
    )
    .map<WorkCandidate>((question) => {
      const targets =
        question.scope.kind === "node" && question.scope.ref
          ? [question.scope.ref]
          : question.scope.kind === "edge"
            ? params.edges
                .filter((edge) => edge.edgeId === question.scope.ref)
                .flatMap((edge) => [edge.source, edge.target])
            : [];
      return {
        kind: "answer_question",
        questionId: question.questionId,
        text: question.text,
        priority: question.priority,
        targets,
        action: `Answer from durable nodes or one targeted read, then resolve_questions {questionId:'${question.questionId}', status:'answered'|'abandoned', resolution}`,
      };
    });
  return [...edgeCandidates, ...questionCandidates];
}

export type PhaseGate = { ok: boolean; blockers: string[] };

/** Stop rules the host enforces before the loop moves on. */
export function evaluatePhaseTransition(params: {
  from: ResearchSynthesisPhase;
  to: ResearchSynthesisPhase;
  corpus: readonly ResearchCorpusItem[];
  findings: readonly PaperFinding[];
  edges: readonly ResearchEdge[];
  themes: readonly ThemeFinding[];
}): PhaseGate {
  const fromIndex = PHASE_INDEX.get(params.from) ?? 0;
  const toIndex = PHASE_INDEX.get(params.to) ?? 0;
  if (toIndex !== fromIndex + 1) {
    return {
      ok: false,
      blockers: [
        `Phases advance one step at a time: ${params.from} -> ${RESEARCH_SYNTHESIS_PHASES[fromIndex + 1] || "complete"}`,
      ],
    };
  }
  const blockers: string[] = [];
  const nodes = new Map(
    params.findings.map((finding) => [
      `${finding.libraryID}:${finding.itemKey}`,
      finding,
    ]),
  );
  const live = params.corpus.filter(
    (item) => item.screeningStatus !== "missing",
  );
  const validEdges = params.edges.filter(
    (edge) => edge.lifecycle === "valid" && edge.status !== "merged",
  );
  if (params.to === "links") {
    const missing = live.filter(
      (item) => !nodes.has(`${item.libraryID}:${item.itemKey}`),
    );
    if (missing.length) {
      blockers.push(
        `${missing.length} papers have no durable node: ${missing
          .map((item) => `${item.libraryID}:${item.itemKey}`)
          .join(", ")}`,
      );
    }
  }
  if (params.to === "verification") {
    if (nodes.size >= 2 && !validEdges.length) {
      blockers.push(
        "No edges are recorded; record the typed relationships between the nodes (or confirm each node's noLinkSeen) before verification",
      );
    }
    const touched = new Set(
      validEdges.flatMap((edge) => [edge.source, edge.target]),
    );
    const isolatedCore = live.filter((item) => {
      const identity = `${item.libraryID}:${item.itemKey}`;
      const node = nodes.get(identity);
      return (
        (item.tier || "core") === "core" &&
        node &&
        !touched.has(identity) &&
        !node.noLinkSeen
      );
    });
    if (isolatedCore.length) {
      blockers.push(
        `Core nodes without any edge or an explicit noLinkSeen: ${isolatedCore
          .map((item) => `${item.libraryID}:${item.itemKey}`)
          .join(", ")}`,
      );
    }
  }
  if (params.to === "structure") {
    const undecided = validEdges.filter(
      (edge) => edge.requiresVerification && edge.status === "candidate",
    );
    if (undecided.length) {
      blockers.push(
        `Edges that must be verified, refuted, or marked tentative first: ${undecided
          .map(
            (edge) =>
              `${edge.edgeId} (${edge.type} ${edge.source} -> ${edge.target})`,
          )
          .join("; ")}`,
      );
    }
  }
  if (params.to === "writing") {
    const validThemes = params.themes.filter(
      (theme) => theme.status !== "invalidated",
    );
    if (nodes.size && !validThemes.length) {
      blockers.push("Record at least one theme bound to edges before writing");
    }
  }
  return { ok: !blockers.length, blockers };
}

export async function advanceSynthesisPhase(params: {
  job: ResearchJob;
  to: ResearchSynthesisPhase;
  corpus: readonly ResearchCorpusItem[];
  conversationKey: number;
  now?: number;
}): Promise<ResearchJob> {
  const now = params.now ?? Date.now();
  if (!RESEARCH_SYNTHESIS_PHASES.includes(params.to)) {
    throw new ToolInputRejection(`Unknown phase ${String(params.to)}`);
  }
  if (params.to === "complete") {
    throw new ToolInputRejection("The complete phase is set by finalize");
  }
  const [findings, edges, themes] = await Promise.all([
    listPaperFindings(params.job.researchJobId),
    listResearchEdges(params.job.researchJobId),
    listThemeFindings(params.job.researchJobId, params.job.scopeLineageDigest),
  ]);
  const gate = evaluatePhaseTransition({
    from: currentPhase(params.job),
    to: params.to,
    corpus: params.corpus,
    findings,
    edges,
    themes,
  });
  if (!gate.ok) {
    throw new ToolInputRejection(
      `Cannot advance to ${params.to}:\n- ${gate.blockers.join("\n- ")}`,
    );
  }
  const updated: ResearchJob = {
    ...params.job,
    synthesisPhase: params.to,
    updatedAt: Math.max(now, params.job.updatedAt + 1),
  };
  await commitResearchRecords(params.job, async () => {
    await saveResearchJob(updated, params.conversationKey);
  });
  return updated;
}

export async function describeNextWork(params: {
  job: ResearchJob;
  corpus: readonly ResearchCorpusItem[];
}) {
  const [findings, edges, questions, themes] = await Promise.all([
    listPaperFindings(params.job.researchJobId),
    listResearchEdges(params.job.researchJobId),
    listResearchOpenQuestions(params.job.researchJobId),
    listThemeFindings(params.job.researchJobId, params.job.scopeLineageDigest),
  ]);
  const phase = currentPhase(params.job);
  const nextPhase =
    RESEARCH_SYNTHESIS_PHASES[(PHASE_INDEX.get(phase) ?? 0) + 1];
  const gate =
    nextPhase && nextPhase !== "complete"
      ? evaluatePhaseTransition({
          from: phase,
          to: nextPhase,
          corpus: params.corpus,
          findings,
          edges,
          themes,
        })
      : { ok: true, blockers: [] };
  const candidates =
    phase === "verification" || phase === "structure"
      ? rankVerificationWork({ edges, questions, corpus: params.corpus })
      : [];
  const valid = edges.filter((edge) => edge.lifecycle === "valid");
  return {
    phase,
    nextPhase,
    phaseComplete: gate.ok,
    blockers: gate.blockers,
    candidates,
    counts: {
      nodes: findings.length,
      edges: valid.length,
      candidateEdges: valid.filter((edge) => edge.status === "candidate")
        .length,
      verifiedEdges: valid.filter((edge) => edge.status === "verified").length,
      tentativeEdges: valid.filter((edge) => edge.status === "tentative")
        .length,
      refutedEdges: valid.filter((edge) => edge.status === "refuted").length,
      openQuestions: questions.filter((question) => question.status === "open")
        .length,
      themes: themes.length,
    },
    instruction:
      phase === "links"
        ? "Record the typed edge list with record_edges (every core node touches an edge or carries noLinkSeen), then advance_phase to verification."
        : phase === "verification"
          ? candidates.length
            ? "Choose from the ranked candidates: required contradictions first. Verify with one targeted paper_read of the pair, then update_edges. Mark an edge tentative with a note when a read cannot settle it. Advance to structure when no required edge is undecided."
            : "No verification candidates remain; advance_phase to structure."
          : phase === "structure"
            ? "Call list_graph, record themes bound to edgeIds, record open questions for structural gaps, then advance_phase to writing."
            : phase === "writing"
              ? "Finalize research and write the document from list_graph; every cross-paper statement cites an edge."
              : "Record a node for every manifest paper.",
  };
}
