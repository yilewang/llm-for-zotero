import type { AgentToolContext } from "../types";
import {
  createAgentToolResultHandleRecord,
  getAgentToolResultHandle,
  upsertAgentToolResultHandles,
  type AgentToolResultHandleRecord,
} from "../store/toolResultHandles";
import {
  areConversationWritesFrozen,
  isConversationWriteGenerationCurrent,
  withConversationWriteLock,
} from "../../shared/conversationWriteFence";
import { isConversationKeyRetiredInMemory } from "../../shared/conversationKeyLedger";

export type LiteratureDiscoveryRequest = {
  batchSize: number;
  mode?: "references" | "citations";
  source?: "openalex" | "arxiv" | "europepmc";
};
export type LiteratureSelection = {
  candidateSetId: string;
  candidateIndex: number;
  reason: string;
};
export type LiteratureReviewInput = {
  selections: LiteratureSelection[];
  sessionId?: string;
  revision?: number;
  targetCollectionId?: number;
  shortfallReason?: string;
  outcome?: "complete" | "no_more" | "search_failed";
};
export type LiteratureCandidateSet = {
  kind: "literature_candidates";
  runId?: string;
  libraryID?: number;
  mode?: string;
  source?: string;
  results: Record<string, unknown>[];
};
export type LiteratureDiscoverySession = {
  kind: "literature_discovery";
  runId?: string;
  libraryID?: number;
  request: LiteratureDiscoveryRequest;
  revision: number;
  phase: "gathering" | "review" | "expanding" | "closed";
  candidateSetIds: string[];
  papers: Record<string, unknown>[];
  selectedIds: string[];
  targetCollectionId?: number;
  destinationLabel?: string;
  shortfallReason?: string;
  outcome: "complete" | "no_more" | "search_failed";
};

export function resolveLiteratureDiscoveryRequest(
  request: AgentToolContext["request"],
): LiteratureDiscoveryRequest {
  const semantic = request.classifiedIntent?.semantic;
  return {
    batchSize: semantic?.requestedCount || 5,
    mode: semantic?.literatureMode,
    source: semantic?.literatureSource,
  };
}

function assertActive(context: AgentToolContext): void {
  const key = context.request.conversationKey;
  if (
    !key ||
    !context.runId ||
    context.signal?.aborted ||
    isConversationKeyRetiredInMemory(key) ||
    areConversationWritesFrozen(key) ||
    (context.request.conversationGeneration !== undefined &&
      !isConversationWriteGenerationCurrent(
        key,
        context.request.conversationGeneration,
      ))
  ) {
    throw new Error(
      "This discovery is no longer active. Start a new discovery request.",
    );
  }
}

function sessionSeed(context: AgentToolContext): AgentToolResultHandleRecord {
  assertActive(context);
  const content: LiteratureDiscoverySession = {
    kind: "literature_discovery",
    runId: context.runId,
    libraryID: context.request.libraryID,
    request: resolveLiteratureDiscoveryRequest(context.request),
    revision: 0,
    phase: "gathering",
    candidateSetIds: [],
    papers: [],
    selectedIds: [],
    outcome: "complete",
  };
  return createAgentToolResultHandleRecord({
    conversationKey: context.request.conversationKey,
    toolName: "literature_review",
    toolCallId: context.runId!,
    resourceSignature: context.resourceSignature,
    content,
  })!;
}

/** One turn-scoped record in the existing result store owns all discovery state. */
export async function getLiteratureDiscovery(
  context: AgentToolContext,
  create = false,
) {
  const seed = sessionSeed(context);
  return withConversationWriteLock(seed.conversationKey, async () => {
    let record = await getAgentToolResultHandle({
      conversationKey: seed.conversationKey,
      handle: seed.handle,
    });
    assertActive(context);
    if (!record && create) {
      await upsertAgentToolResultHandles([seed]);
      record = seed;
    }
    if (!record) return null;
    return { record, session: record.content as LiteratureDiscoverySession };
  });
}

async function save(
  record: AgentToolResultHandleRecord,
  context: AgentToolContext,
) {
  assertActive(context);
  await upsertAgentToolResultHandles([record]);
}

/** Match identifiers across providers, with normalized title as a metadata fallback. */
export function literaturePaperIdentities(
  paper: Record<string, unknown>,
): string[] {
  const keys: string[] = [];
  const doi = String(paper.doi || "")
    .toLowerCase()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//, "")
    .trim();
  if (doi) keys.push(`doi:${doi}`);
  const arxiv = String(paper.arxivId || "")
    .toLowerCase()
    .replace(/^arxiv:/, "")
    .replace(/v\d+$/, "")
    .trim();
  if (arxiv) keys.push(`arxiv:${arxiv}`);
  for (const value of [paper.id, paper.sourceUrl]) {
    if (typeof value === "string" && value.trim())
      keys.push(
        value
          .toLowerCase()
          .replace(/^https?:\/\//, "")
          .replace(/\/$/, ""),
      );
  }
  const title = String(paper.title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  if (title && !keys.length) keys.push(`title:${title}:${paper.year || ""}`);
  return keys;
}

export function discoveryContent(record: AgentToolResultHandleRecord) {
  const session = record.content as LiteratureDiscoverySession;
  return {
    mode: "search",
    sessionId: record.handle,
    revision: session.revision,
    discoveryPhase: session.phase,
    batchSize: session.request.batchSize,
    results: session.papers.map((p) => ({
      ...p,
      checked: session.selectedIds.includes(String(p.discoveryPaperId)),
    })),
    reviewRequired: true,
    libraryID: session.libraryID,
    targetCollectionId: session.targetCollectionId,
    destinationLabel: session.destinationLabel,
    shortfallReason: session.shortfallReason,
    outcome: session.outcome,
  };
}

export async function identifyLiteratureCandidates(
  content: Record<string, unknown>,
  context: AgentToolContext,
  reviewRequired: boolean,
): Promise<Record<string, unknown>> {
  const results = Array.isArray(content.results) ? content.results : [];
  const discovery = reviewRequired
    ? await getLiteratureDiscovery(context, true)
    : null;
  const set: LiteratureCandidateSet = {
    kind: "literature_candidates",
    runId: context.runId,
    libraryID: context.request.libraryID,
    mode: String(content.mode || "search"),
    source: String(content.source || ""),
    results,
  };
  const record = createAgentToolResultHandleRecord({
    conversationKey: context.request.conversationKey,
    toolName: "literature_search",
    toolCallId: context.runId || "literature-search",
    resourceSignature: context.resourceSignature,
    content: set,
  });
  if (!record) return { ...content, reviewRequired: false };
  await upsertAgentToolResultHandles([record]);
  if (discovery) {
    if (!discovery.session.candidateSetIds.includes(record.handle))
      discovery.session.candidateSetIds.push(record.handle);
    await save(discovery.record, context);
  }
  return {
    ...content,
    candidateSetId: record.handle,
    results: results.map((r, index) => ({ ...r, candidateIndex: index + 1 })),
    reviewRequired,
    ...(discovery
      ? {
          sessionId: discovery.record.handle,
          revision: discovery.session.revision,
          nextStep: discoveryInstruction(discovery.record),
        }
      : {}),
  };
}

function discoveryInstruction(record: AgentToolResultHandleRecord): string {
  const s = record.content as LiteratureDiscoverySession;
  return `Assess titles and abstracts and select ${s.request.batchSize} ${s.papers.length ? "additional " : ""}genuinely relevant papers in ranked order. Respect the user's topic and these constraints: ${JSON.stringify(s.request)}. Assess unused saved candidates first; search further if needed. To expand a provider list, increase its retrieval limit rather than repeating the same bounded request. Call literature_review with sessionId '${record.handle}', revision ${s.revision}, NEW candidateSetId/candidateIndex selections and evidence-based relevance reasons. Do not repeat displayed papers or dump the raw pool. If fewer qualify, explain shortfallReason; use outcome 'no_more' when no further relevant matches were found, or 'search_failed' for a retrieval failure. Empty selections with an explanation are allowed. Never import during discovery or finish with prose instead of the card.`;
}

export async function prepareLiteratureDiscoveryReview(
  input: LiteratureReviewInput,
  context: AgentToolContext,
  destination: { targetCollectionId?: number; destinationLabel: string },
) {
  const discovery = await getLiteratureDiscovery(context, true);
  const { record, session } = discovery!;
  if (
    session.phase === "closed" ||
    session.phase === "review" ||
    (input.sessionId !== undefined && input.sessionId !== record.handle) ||
    (input.revision !== undefined && input.revision !== session.revision) ||
    (session.revision > 0 &&
      (input.sessionId !== record.handle ||
        input.revision !== session.revision))
  ) {
    throw new Error(
      "This discovery review is stale. Use the active sessionId and revision from Find more.",
    );
  }
  const expectedPhase = session.phase;
  const expectedRevision = session.revision;
  const identities = new Set(session.papers.flatMap(literaturePaperIdentities));
  const selected: Record<string, unknown>[] = [];
  for (const selection of input.selections) {
    const saved = await getAgentToolResultHandle({
      conversationKey: record.conversationKey,
      handle: selection.candidateSetId,
    });
    const set = saved?.content as LiteratureCandidateSet | undefined;
    if (
      !saved ||
      saved.toolName !== "literature_search" ||
      set?.kind !== "literature_candidates" ||
      set.runId !== context.runId ||
      set.libraryID !== context.request.libraryID ||
      saved.resourceSignature !== context.resourceSignature
    ) {
      throw new Error(
        "Candidate set is unavailable or belongs to another turn/library/paper. Search again before reviewing.",
      );
    }
    if (session.request.mode && set.mode !== session.request.mode)
      throw new Error(
        `Only ${session.request.mode} candidates satisfy this discovery request.`,
      );
    if (
      session.request.source &&
      set.source?.toLowerCase().replace(/\s/g, "") !== session.request.source
    )
      throw new Error(
        `Only ${session.request.source} candidates satisfy this discovery request.`,
      );
    const candidate = set.results[selection.candidateIndex - 1];
    if (!candidate)
      throw new Error(
        "Candidate index does not exist in the saved search results.",
      );
    const keys = literaturePaperIdentities(candidate);
    if (!keys.length || keys.some((key) => identities.has(key)))
      throw new Error(
        "The shortlist repeats a paper already selected or displayed.",
      );
    keys.forEach((key) => identities.add(key));
    selected.push({
      ...candidate,
      relevanceReason: selection.reason,
      discoveryPaperId: keys[0],
    });
  }
  if (
    selected.length > session.request.batchSize ||
    (selected.length < session.request.batchSize && !input.shortfallReason)
  ) {
    throw new Error(
      `Review requires ${session.request.batchSize} new ranked papers, not ${selected.length}. Search further or disclose a genuine shortfall.`,
    );
  }
  assertActive(context);
  if (session.phase !== expectedPhase || session.revision !== expectedRevision)
    throw new Error("The discovery changed while preparing this batch.");
  session.papers.push(...selected);
  session.selectedIds.push(...selected.map((p) => String(p.discoveryPaperId)));
  session.targetCollectionId = destination.targetCollectionId;
  session.destinationLabel = destination.destinationLabel;
  session.phase = "review";
  session.shortfallReason = input.shortfallReason;
  session.outcome = input.outcome || "complete";
  await save(record, context);
  return discovery!;
}

export async function resolveLiteratureDiscoveryReview(
  content: { sessionId?: string; revision?: number },
  actionId: string,
  selectedIds: unknown,
  context: AgentToolContext,
) {
  const discovery = await getLiteratureDiscovery(context);
  if (
    !discovery ||
    content.sessionId !== discovery.record.handle ||
    content.revision !== discovery.session.revision ||
    discovery.session.phase !== "review"
  ) {
    throw new Error("This discovery card is no longer active.");
  }
  const { record, session } = discovery;
  const allowed = new Set(
    session.papers.map((p) => String(p.discoveryPaperId)),
  );
  if (Array.isArray(selectedIds)) {
    if (selectedIds.some((id) => typeof id !== "string" || !allowed.has(id)))
      throw new Error("Unknown paper selection.");
    session.selectedIds = [...new Set(selectedIds as string[])];
  }
  if (actionId === "find_more") {
    if (session.outcome === "no_more")
      throw new Error(
        "No additional relevant matches were found for this discovery.",
      );
    session.phase = "expanding";
    session.revision += 1;
    session.shortfallReason = undefined;
    session.outcome = "complete";
  } else {
    session.phase = "closed";
  }
  await save(record, context);
  return {
    ...discoveryContent(record),
    candidateSetIds: session.candidateSetIds,
    nextStep: discoveryInstruction(record),
  };
}
