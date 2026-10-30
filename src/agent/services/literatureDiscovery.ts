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
import { normalizeArxivId, normalizeDoi } from "./paperWorkIdentity";
import { OUTSIDE_SEARCH_STOP_NOTE } from "../tools/read/outsideSearchNeed";
import {
  findOutsidePaperRecord,
  outsidePaperRecordsFromToolResult,
  rememberOutsidePapers,
  setOutsidePaperSelection,
} from "../context/outsidePaperRecords";

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
  /** The number of papers the user asked for; sets the first batch's size. */
  count?: number;
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
  /**
   * The papers the user chose with the card's Import: the only candidates of
   * this discovery an import may take.
   */
  approvedIds?: string[];
  /**
   * Set when a search of this discovery said its papers are candidates for
   * a literature review the Agent will write: the card then asks whether to
   * import and cite them or to cite them without importing.
   */
  forLiteratureReview?: boolean;
  /** The papers the user chose with the card's Cite without importing. */
  citedIds?: string[];
  targetCollectionId?: number;
  destinationLabel?: string;
  shortfallReason?: string;
  outcome: "complete" | "no_more" | "search_failed";
};

/** A discovery shows the number of papers the user asked for, five when unspecified. */
export const DEFAULT_DISCOVERY_COUNT = 5;
export const MAX_DISCOVERY_COUNT = 25;

/** A tool call's count: undefined when absent, null when it is not 1–25. */
export function parseDiscoveryCount(value: unknown): number | undefined | null {
  if (value === undefined) return undefined;
  return Number.isSafeInteger(value) &&
    (value as number) >= 1 &&
    (value as number) <= MAX_DISCOVERY_COUNT
    ? (value as number)
    : null;
}

/**
 * The request a discovery opens with. It seeds the turn's one discovery
 * record, whose handle derives from this seed, so it never varies with a
 * call: a requested count is applied to the record after it is found.
 */
export function resolveLiteratureDiscoveryRequest(): LiteratureDiscoveryRequest {
  return { batchSize: DEFAULT_DISCOVERY_COUNT };
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

/** The turn's discovery record as first stored; null without a turn to own one. */
function discoverySeed(
  context: AgentToolContext,
): AgentToolResultHandleRecord | null {
  const content: LiteratureDiscoverySession = {
    kind: "literature_discovery",
    runId: context.runId,
    libraryID: context.request.libraryID,
    request: resolveLiteratureDiscoveryRequest(),
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
    toolCallId: context.runId || "",
    resourceSignature: context.resourceSignature,
    content,
  });
}

function sessionSeed(context: AgentToolContext): AgentToolResultHandleRecord {
  assertActive(context);
  return discoverySeed(context)!;
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
  const doi = normalizeDoi(paper.doi);
  if (doi) keys.push(`doi:${doi}`);
  const arxiv = normalizeArxivId(paper.arxivId);
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
  // Ids derived from an arXiv DOI or URL follow the provider keys. A result
  // with an arxivId and no DOI now leads with the canonical "arxiv:<id>" key
  // instead of its abs-URL key. Stored sessions keep their ids, and the
  // duplicate check matches on all keys, which still overlap.
  for (const derived of [
    doi.match(/^10\.48550\/arxiv\.(.+)$/)?.[1],
    paper.id,
    paper.sourceUrl,
  ]) {
    const id = normalizeArxivId(derived);
    if (id && !keys.includes(`arxiv:${id}`)) keys.push(`arxiv:${id}`);
  }
  const title = String(paper.title || "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]/gu, "");
  if (title && !keys.length) keys.push(`title:${title}:${paper.year || ""}`);
  return keys;
}

/** The keys a library_import identifier, a DOI or arXiv id in any form, names. */
function importIdentities(identifier: string): string[] {
  return [
    ...literaturePaperIdentities({ doi: identifier }),
    ...literaturePaperIdentities({ arxivId: identifier }),
  ];
}

/**
 * The keys a saved candidate can be imported by: its identities, and the
 * arXiv id of an arXiv open-access link, which the card itself imports by.
 */
function candidateIdentities(paper: unknown): string[] {
  if (!paper || typeof paper !== "object") return [];
  const record = paper as Record<string, unknown>;
  return [
    ...literaturePaperIdentities(record),
    ...literaturePaperIdentities({ arxivId: record.openAccessUrl }),
  ];
}

/**
 * Why a library_import of these identifiers must not run: this turn opened
 * a paper discovery, and they name candidates it saved or showed that the
 * user did not choose with the card's Import. Discovered papers reach Zotero
 * only through the paper selection card, in every permission mode, so the
 * refusal sends the model to the card. Null when no discovery of this turn
 * holds them.
 */
export async function discoveryImportRefusal(
  identifiers: readonly string[],
  context: AgentToolContext,
): Promise<string | null> {
  const seed = discoverySeed(context);
  if (!seed) return null;
  const record = await getAgentToolResultHandle({
    conversationKey: seed.conversationKey,
    handle: seed.handle,
  });
  const session = record?.content as LiteratureDiscoverySession | undefined;
  if (!record || session?.kind !== "literature_discovery") return null;
  const candidates = new Set(session.papers.flatMap(candidateIdentities));
  for (const handle of session.candidateSetIds) {
    const saved = await getAgentToolResultHandle({
      conversationKey: record.conversationKey,
      handle,
    });
    const set = saved?.content as LiteratureCandidateSet | undefined;
    if (set?.kind !== "literature_candidates" || !Array.isArray(set.results))
      continue;
    for (const key of set.results.flatMap(candidateIdentities))
      candidates.add(key);
  }
  const approved = new Set(
    session.papers
      .filter((paper) =>
        (session.approvedIds || []).includes(String(paper.discoveryPaperId)),
      )
      .flatMap(candidateIdentities),
  );
  const unchosen = identifiers.filter((identifier) => {
    const keys = importIdentities(identifier);
    return (
      keys.some((key) => candidates.has(key)) &&
      !keys.some((key) => approved.has(key))
    );
  });
  if (!unchosen.length) return null;
  const cited = new Set(
    session.papers
      .filter((paper) =>
        (session.citedIds || []).includes(String(paper.discoveryPaperId)),
      )
      .flatMap(candidateIdentities),
  );
  if (
    unchosen.every((identifier) =>
      importIdentities(identifier).some((key) => cited.has(key)),
    )
  )
    return `Nothing was imported: the user chose to cite ${unchosen.join(", ")} without importing on the paper selection card. Cite ${unchosen.length === 1 ? "it" : "them"} by paperId; import ${unchosen.length === 1 ? "it" : "them"} later, when the user asks.`;
  const named = `${unchosen.join(", ")} ${unchosen.length === 1 ? "is a paper" : "are papers"} this turn's discovery found`;
  return session.phase === "closed"
    ? `Nothing was imported: ${named}, and the user did not choose ${unchosen.length === 1 ? "it" : "them"} on its paper selection card. Discovered papers are imported only after the user selects them there.`
    : `Nothing was imported: ${named}, and discovered papers are imported only after the user selects them on the paper selection card. Call literature_review with sessionId '${record.handle}', revision ${session.revision} and ranked candidateSetId/candidateIndex selections to show them, so the user can choose.`;
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
    ...(session.forLiteratureReview ? { forLiteratureReview: true } : {}),
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
  routeImports = false,
  count?: number,
  /** The closing note: the turn's outside-search ledger and stop note. */
  closingNote: string = OUTSIDE_SEARCH_STOP_NOTE,
  /** The papers are candidates for a literature review the Agent will write. */
  forLiteratureReview = false,
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
  if (!record)
    return {
      ...content,
      reviewRequired: false,
      nextStep: closingNote,
    };
  await upsertAgentToolResultHandles([record]);
  if (discovery) {
    if (!discovery.session.candidateSetIds.includes(record.handle))
      discovery.session.candidateSetIds.push(record.handle);
    // A count asked for before the first batch is shown sets its size.
    if (count !== undefined && !discovery.session.papers.length)
      discovery.session.request = {
        ...discovery.session.request,
        batchSize: count,
      };
    // One search for a review marks the whole discovery, Find more included.
    if (forLiteratureReview) discovery.session.forLiteratureReview = true;
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
      : {
          nextStep: routeImports
            ? `${CANDIDATE_ROUTE} ${closingNote}`
            : closingNote,
        }),
  };
}

/**
 * A workflow:'answer' search opens no discovery, so its result routes by the
 * user's request, read when the model picks its next tool. Answering is the
 * default; for callers that can import, the explicit-import branch follows.
 * An answer result never names the selection card: a find or recommend
 * request takes workflow:'review' (the tool description says so), and a
 * card branch on every evidence result led evidence questions to the card.
 * Every answer result ends with the closing note (the turn's outside-search
 * ledger and stop note); MCP callers get the closing note alone. A
 * workflow:'review' search opened a discovery, whose candidates import only
 * through the card (discoveryImportRefusal), so its next step offers the
 * card alone. Only a Find more continuation (revision above 0) forbids prose
 * outright; a first batch may end in an answer when the user did not ask for
 * papers themselves, so an evidence question sent here by mistake is not
 * forced to the card.
 */
const ANSWER_ROUTE =
  "Unless the user asked to import papers or only to find or recommend them, answer the user's question from these results as supporting evidence; the turn's own papers remain the primary source.";
const IMPORT_ROUTE =
  "If the user asked to import or add papers to Zotero without asking to choose them first, skip the selection card: rank these candidates, skip papers already in the library, then call library_import with the DOI or arXiv identifiers of exactly the number the user requested and the requested destination (targetCollectionId; create the collection first only when the user named a new one).";
const CANDIDATE_ROUTE = `${ANSWER_ROUTE} ${IMPORT_ROUTE}`;

function discoveryInstruction(record: AgentToolResultHandleRecord): string {
  const s = record.content as LiteratureDiscoverySession;
  const select = `titles and abstracts and select ${s.request.batchSize} ${s.papers.length ? "additional " : ""}genuinely relevant papers in ranked order${s.papers.length ? "" : " (pass the number the user asked for as count when it differs)"}. Respect the user's topic and these constraints: ${JSON.stringify(s.request)}. Assess unused saved candidates first; search further if needed. A further search uses workflow:'review'. To expand a provider list, increase its retrieval limit rather than repeating the same bounded request.`;
  const review = `literature_review with sessionId '${record.handle}', revision ${s.revision}, NEW candidateSetId/candidateIndex selections and evidence-based relevance reasons. Do not repeat displayed papers or dump the raw pool. If fewer qualify, explain shortfallReason; use outcome 'no_more' when no further relevant matches were found, or 'search_failed' for a retrieval failure. Empty selections with an explanation are allowed.`;
  return `Assess ${select} Call ${review} ${s.revision ? "Never import during discovery or finish with prose instead of the card." : "Never import during discovery. If the user asked for papers themselves, finish with the card, not prose; otherwise answer without it."}`;
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
  // The first batch takes the count it was asked for; Find more keeps it.
  const batchSize =
    input.count !== undefined && !session.papers.length
      ? input.count
      : session.request.batchSize;
  if (input.count !== undefined && input.count !== batchSize)
    throw new Error(
      `This discovery shows batches of ${batchSize} papers; Find more keeps the first batch's size.`,
    );
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
    selected.length > batchSize ||
    (selected.length < batchSize && !input.shortfallReason)
  ) {
    throw new Error(
      `Review requires ${batchSize} new ranked papers, not ${selected.length}. Search further or disclose a genuine shortfall.`,
    );
  }
  assertActive(context);
  if (session.phase !== expectedPhase || session.revision !== expectedRevision)
    throw new Error("The discovery changed while preparing this batch.");
  session.request = { ...session.request, batchSize };
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
    // Import is the user's choice; only the papers checked with it may be
    // imported. A selection the card did not send approves nothing.
    if (actionId === "import")
      session.approvedIds = Array.isArray(selectedIds)
        ? [...session.selectedIds]
        : [];
    // Cite without importing approves no import; a selection the card did
    // not send chooses nothing.
    if (actionId === "cite")
      session.citedIds = Array.isArray(selectedIds)
        ? [...session.selectedIds]
        : [];
  }
  await save(record, context);
  return {
    ...discoveryContent(record),
    candidateSetIds: session.candidateSetIds,
    nextStep: discoveryInstruction(record),
  };
}

/**
 * The card's Cite without importing: the papers the user ticked become the
 * run's only citable outside papers, cited by paperId and never imported.
 * They join the run's record of outside papers here, so a paper Find more
 * showed is citable too, whichever search returned it.
 */
export function citeDiscoveredPapers(
  papers: readonly Record<string, unknown>[],
  context: AgentToolContext,
): Record<string, unknown> {
  const records = outsidePaperRecordsFromToolResult("literature_search", {
    mode: "search",
    results: papers,
  });
  rememberOutsidePapers(context.request, records);
  // The run may know a paper under an earlier id, which the selection holds.
  const ids = records.map(
    (record) =>
      findOutsidePaperRecord(context.request, record.paperId)?.paperId ||
      record.paperId,
  );
  setOutsidePaperSelection(context.request, ids);
  return {
    choice: "cite_without_importing",
    papers: records.map((record, index) => ({
      paperId: ids[index],
      ...(record.title ? { title: record.title } : {}),
      ...(record.year !== undefined ? { year: record.year } : {}),
      ...(record.doi ? { doi: record.doi } : {}),
    })),
    nextStep: records.length
      ? "The user chose to cite these papers without importing them. Read each with literature_read, then cite it in submit_document by its paperId; do not import them, and cite no other outside paper."
      : "The user chose no paper to cite; cite no outside paper.",
  };
}
