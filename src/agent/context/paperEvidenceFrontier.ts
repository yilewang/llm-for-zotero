import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import {
  resolveReadStopGuidance,
  type ReadStopPolicy,
  type ReadStopRecommendation,
} from "./evidencePolicy";

export type PaperEvidenceProgress = {
  frontier: "advanced" | "unchanged" | "unavailable";
  coverage: "metadata" | "overview" | "targeted" | "full";
  newOccurrenceIds: string[];
  repeatedOccurrenceIds: string[];
  cumulativeOccurrenceCount: number;
  recommendation: ReadStopRecommendation;
  reason: string;
  /** Eligible paper reads so far in this turn, including reused calls. */
  readsThisTurn?: number;
  /** Reads after which the requested coverage asks the model to answer. */
  readBudget?: number;
};

/** Default when the turn declares no reading requirement: drain the source. */
const EXHAUSTIVE_STOP_POLICY: ReadStopPolicy = {
  coverage: "exhaustive",
  readBudget: Number.POSITIVE_INFINITY,
};

export type PaperEvidenceReference = {
  displayLabel?: string;
  sourceToolCallId: string;
  occurrenceId?: string;
  contentHash?: string;
  quoteCitationIds: string[];
  toolResultHandle?: string;
  repeatedContentOccurrenceIds?: string[];
};

type Occurrence = {
  displayLabel?: string;
  occurrenceId?: string;
  contentHash?: string;
  quoteCitationIds: string[];
};

type StoredOccurrence = PaperEvidenceReference & {
  occurrenceId: string;
};

type CachedCall = {
  coverage: PaperEvidenceProgress["coverage"];
  unavailable: boolean;
  references: PaperEvidenceReference[];
  failOpenContent?: Record<string, unknown>;
};

export type PaperEvidenceResult = {
  content: unknown;
  frontier: PaperEvidenceProgress["frontier"];
  originalContent?: unknown;
  toolResultHandle?: string;
};

type ProcessParams = {
  input: unknown;
  content: unknown;
  toolCallId: string;
  resourceSignature?: string;
  persistOriginal?: (content: unknown) => Promise<string | undefined>;
};

type CacheLookupParams = {
  input: unknown;
  toolCallId: string;
  resourceSignature?: string;
};

function objectRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizedString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized || undefined;
}

function normalizedInteger(value: unknown): number | undefined {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0
    ? Math.floor(parsed)
    : undefined;
}

function normalizedStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [
    ...new Set(
      value
        .map(normalizedString)
        .filter((entry): entry is string => Boolean(entry)),
    ),
  ];
}

function paperReadMode(input: unknown): string {
  return (
    normalizedString(objectRecord(input)?.mode)?.toLowerCase() || "overview"
  );
}

export function isPaperEvidenceFrontierEligible(input: unknown): boolean {
  const mode = paperReadMode(input);
  return mode === "overview" || mode === "targeted";
}

function normalizeTarget(value: unknown): unknown {
  const target = objectRecord(value);
  if (!target) return value;
  const paperContext = objectRecord(target.paperContext);
  const source = paperContext ? { ...target, ...paperContext } : target;
  return {
    libraryID: normalizedInteger(source.libraryID),
    itemId: normalizedInteger(source.itemId),
    contextItemId: normalizedInteger(source.contextItemId),
    itemKey: normalizedString(source.itemKey),
    contextItemKey: normalizedString(source.contextItemKey),
    attachmentId: normalizedInteger(source.attachmentId),
    name: normalizedString(source.name),
  };
}

function normalizeCallInput(input: unknown): unknown {
  const record = objectRecord(input);
  if (!record) return input;
  const targets = Array.isArray(record.targets)
    ? record.targets
        .map(normalizeTarget)
        .sort((left, right) =>
          canonicalJson(left).localeCompare(canonicalJson(right)),
        )
    : undefined;
  const pages = Array.isArray(record.pages)
    ? [
        ...new Set(
          record.pages
            .map(normalizedInteger)
            .filter((entry): entry is number => entry !== undefined),
        ),
      ].sort((left, right) => left - right)
    : undefined;
  return {
    mode: paperReadMode(input),
    target:
      record.target === undefined ? undefined : normalizeTarget(record.target),
    targets,
    query: normalizedString(record.query),
    queryVariants: normalizedStringArray(record.queryVariants).sort(),
    sections: normalizedStringArray(record.sections).sort(),
    pages,
    neighborPages: normalizedInteger(record.neighborPages),
    maxChars: normalizedInteger(record.maxChars),
    topK: normalizedInteger(record.topK),
  };
}

async function callKey(
  input: unknown,
  resourceSignature: string | undefined,
): Promise<string> {
  return `paper-call:${await sha256Text(
    canonicalJson({
      input: normalizeCallInput(input),
      resourceSignature: normalizedString(resourceSignature),
    }),
  )}`;
}

function paperIdentity(
  entry: Record<string, unknown>,
  inheritedPaperContext?: Record<string, unknown>,
): Record<string, unknown> | null {
  const paperContext =
    objectRecord(entry.paperContext) || inheritedPaperContext;
  if (!paperContext) return null;
  const identity = {
    libraryID: normalizedInteger(paperContext.libraryID),
    itemId: normalizedInteger(paperContext.itemId),
    contextItemId: normalizedInteger(paperContext.contextItemId),
    itemKey: normalizedString(paperContext.itemKey),
    contextItemKey: normalizedString(paperContext.contextItemKey),
  };
  return identity.itemId || identity.itemKey ? identity : null;
}

function sourceLocator(
  entry: Record<string, unknown>,
  mode: string,
): Record<string, unknown> | null {
  const locator = {
    chunkIndex: normalizedInteger(entry.chunkIndex),
    pageIndex: normalizedInteger(entry.pageIndex),
    sourceStart: normalizedInteger(entry.sourceStart),
    sourceEnd: normalizedInteger(entry.sourceEnd),
    pageStart: normalizedInteger(entry.pageStart),
    pageEnd: normalizedInteger(entry.pageEnd),
  };
  if (Object.values(locator).some((value) => value !== undefined)) {
    return locator;
  }
  return mode === "overview" ? { overview: true } : null;
}

async function buildOccurrence(params: {
  entry: Record<string, unknown>;
  inheritedPaperContext?: Record<string, unknown>;
  inheritedSourceKind?: string;
  mode: string;
  resourceSignature?: string;
}): Promise<Occurrence> {
  const text = normalizedString(params.entry.text);
  const quoteCitationIds = [
    ...normalizedStringArray(params.entry.quoteCitationIds),
    ...(normalizedString(params.entry.quoteCitationId)
      ? [normalizedString(params.entry.quoteCitationId)!]
      : []),
  ].filter((entry, index, all) => all.indexOf(entry) === index);
  const contentHash = text
    ? `sha256:${await sha256Text(text.toLocaleLowerCase())}`
    : undefined;
  const paper = paperIdentity(params.entry, params.inheritedPaperContext);
  const locator = sourceLocator(params.entry, params.mode);
  const sourceFingerprint =
    normalizedString(params.entry.sourceFingerprint) ||
    normalizedString(params.resourceSignature);
  if (!text || !paper || !locator || !sourceFingerprint) {
    return { contentHash, quoteCitationIds };
  }
  const occurrenceId = `paper-occurrence:${await sha256Text(
    canonicalJson({
      paper,
      sourceFingerprint,
      turnResourceSignature: normalizedString(params.resourceSignature),
      sourceKind:
        normalizedString(params.entry.sourceKind) ||
        params.inheritedSourceKind ||
        "paper_text",
      locator,
      sectionLabel: normalizedString(params.entry.sectionLabel),
    }),
  )}`;
  return {
    occurrenceId,
    contentHash,
    quoteCitationIds,
    displayLabel: normalizedString(params.entry.displayLabel),
  };
}

async function collectOccurrences(params: {
  content: Record<string, unknown>;
  mode: string;
  resourceSignature?: string;
}): Promise<Occurrence[]> {
  const occurrences: Occurrence[] = [];
  const papers = Array.isArray(params.content.papers)
    ? params.content.papers
    : [];
  let groupedPassageCount = 0;
  for (const paperValue of papers) {
    const paper = objectRecord(paperValue);
    if (!paper || !Array.isArray(paper.passages)) continue;
    const inheritedPaperContext = objectRecord(paper.paperContext) || undefined;
    const inheritedSourceKind = normalizedString(paper.sourceKind);
    for (const passageValue of paper.passages) {
      const passage = objectRecord(passageValue);
      if (!passage) continue;
      groupedPassageCount += 1;
      occurrences.push(
        await buildOccurrence({
          entry: passage,
          inheritedPaperContext,
          inheritedSourceKind,
          mode: params.mode,
          resourceSignature: params.resourceSignature,
        }),
      );
    }
  }
  if (groupedPassageCount) return occurrences;
  const results = Array.isArray(params.content.results)
    ? params.content.results
    : [];
  for (const resultValue of results) {
    const result = objectRecord(resultValue);
    if (!result) continue;
    occurrences.push(
      await buildOccurrence({
        entry: result,
        mode: params.mode,
        resourceSignature: params.resourceSignature,
      }),
    );
  }
  return occurrences;
}

function hasTextualEvidence(content: Record<string, unknown>): boolean {
  const hasText = (value: unknown) =>
    Boolean(normalizedString(objectRecord(value)?.text));
  if (Array.isArray(content.results) && content.results.some(hasText)) {
    return true;
  }
  return (
    Array.isArray(content.papers) &&
    content.papers.some((paperValue) => {
      const paper = objectRecord(paperValue);
      return Array.isArray(paper?.passages) && paper.passages.some(hasText);
    })
  );
}

function resolveCoverage(
  content: Record<string, unknown>,
  mode: string,
): PaperEvidenceProgress["coverage"] {
  const results = Array.isArray(content.results) ? content.results : [];
  const textualSources = results
    .map(objectRecord)
    .filter((entry): entry is Record<string, unknown> => Boolean(entry));
  if (
    textualSources.length > 0 &&
    textualSources.every(
      (entry) =>
        normalizedString(entry.sourceKind) === "zotero_metadata" ||
        normalizedString(entry.backend) === "zotero_metadata",
    )
  ) {
    return "metadata";
  }
  return mode === "overview" ? "overview" : "targeted";
}

async function occurrenceIdForEntry(params: {
  entry: Record<string, unknown>;
  inheritedPaperContext?: Record<string, unknown>;
  inheritedSourceKind?: string;
  mode: string;
  resourceSignature?: string;
}): Promise<string | undefined> {
  return (
    await buildOccurrence({
      entry: params.entry,
      inheritedPaperContext: params.inheritedPaperContext,
      inheritedSourceKind: params.inheritedSourceKind,
      mode: params.mode,
      resourceSignature: params.resourceSignature,
    })
  ).occurrenceId;
}

async function suppressRepeatedOccurrences(params: {
  content: Record<string, unknown>;
  repeatedIds: Set<string>;
  mode: string;
  resourceSignature?: string;
  repeatedQuoteCitationIds: Set<string>;
  retainedQuoteCitationIds: Set<string>;
}): Promise<Record<string, unknown>> {
  const output = { ...params.content };
  if (Array.isArray(params.content.results)) {
    const results = [];
    for (const value of params.content.results) {
      const entry = objectRecord(value);
      if (!entry) {
        results.push(value);
        continue;
      }
      const id = await occurrenceIdForEntry({
        entry,
        mode: params.mode,
        resourceSignature: params.resourceSignature,
      });
      if (!id || !params.repeatedIds.has(id)) results.push(value);
    }
    output.results = results;
  }
  if (Array.isArray(params.content.papers)) {
    const papers = [];
    for (const paperValue of params.content.papers) {
      const paper = objectRecord(paperValue);
      if (!paper || !Array.isArray(paper.passages)) {
        papers.push(paperValue);
        continue;
      }
      const passages = [];
      const inheritedPaperContext =
        objectRecord(paper.paperContext) || undefined;
      const inheritedSourceKind = normalizedString(paper.sourceKind);
      for (const passageValue of paper.passages) {
        const passage = objectRecord(passageValue);
        if (!passage) {
          passages.push(passageValue);
          continue;
        }
        const id = await occurrenceIdForEntry({
          entry: passage,
          inheritedPaperContext,
          inheritedSourceKind,
          mode: params.mode,
          resourceSignature: params.resourceSignature,
        });
        if (!id || !params.repeatedIds.has(id)) passages.push(passageValue);
      }
      papers.push({
        ...paper,
        passages,
        status: passages.length ? paper.status : "already_delivered",
      });
    }
    output.papers = papers;
  }
  if (Array.isArray(params.content.quoteCitations)) {
    output.quoteCitations = params.content.quoteCitations.filter((value) => {
      const id = normalizedString(objectRecord(value)?.id);
      if (!id) return true;
      return (
        !params.repeatedQuoteCitationIds.has(id) ||
        params.retainedQuoteCitationIds.has(id)
      );
    });
  }
  return output;
}

function progressFor(params: {
  frontier: PaperEvidenceProgress["frontier"];
  coverage: PaperEvidenceProgress["coverage"];
  newOccurrenceIds: string[];
  repeatedOccurrenceIds: string[];
  cumulativeOccurrenceCount: number;
  stopPolicy: ReadStopPolicy;
  readsThisTurn: number;
  planExecuting: boolean;
}): PaperEvidenceProgress {
  const { stopPolicy, planExecuting, ...progress } = params;
  if (planExecuting) {
    // An approved plan owns reading: the manifest decides what to read next
    // and the host completes the reading task from durable records. Chat
    // stop guidance ("answer now") would be a second, contradicting owner.
    return {
      ...progress,
      recommendation: "continue_plan",
      reason:
        progress.frontier === "unavailable"
          ? "This source delivered no readable text; record what the manifest allows for it and continue the approved plan."
          : "Continue the approved plan: persist this group with research_update before reading the next manifest group.",
    };
  }
  const guidance = resolveReadStopGuidance(stopPolicy, {
    frontier: params.frontier,
    readsThisTurn: params.readsThisTurn,
  });
  return {
    ...progress,
    ...(Number.isFinite(stopPolicy.readBudget)
      ? { readBudget: stopPolicy.readBudget }
      : {}),
    recommendation: guidance.recommendation,
    reason: guidance.reason,
  };
}

export class PaperEvidenceFrontier {
  private readonly seenOccurrences = new Map<string, StoredOccurrence>();
  private readonly occurrencesByContentHash = new Map<string, Set<string>>();
  private readonly cachedCalls = new Map<string, CachedCall>();
  private readonly stopPolicy: ReadStopPolicy;
  private readonly planExecuting: boolean;
  private readsThisTurn = 0;

  constructor(
    options: {
      evidencePolicy?: ReadStopPolicy | null;
      /** True while an approved plan executes; reads then never stop the turn. */
      planExecuting?: boolean;
    } = {},
  ) {
    this.stopPolicy = options.evidencePolicy || EXHAUSTIVE_STOP_POLICY;
    this.planExecuting = options.planExecuting === true;
  }

  async readCached(
    params: CacheLookupParams,
  ): Promise<PaperEvidenceResult | null> {
    if (!isPaperEvidenceFrontierEligible(params.input)) return null;
    const cached = this.cachedCalls.get(
      await callKey(params.input, params.resourceSignature),
    );
    if (!cached) return null;
    this.readsThisTurn += 1;
    if (cached.failOpenContent) {
      return {
        frontier: "advanced",
        content: {
          ...cached.failOpenContent,
          cacheStatus: "identical_call_reused",
          paperEvidenceProgress: {
            frontier: "advanced",
            coverage: cached.coverage,
            newOccurrenceIds: [],
            repeatedOccurrenceIds: [],
            cumulativeOccurrenceCount: this.seenOccurrences.size,
            readsThisTurn: this.readsThisTurn,
            recommendation: "answer_or_self_check",
            reason:
              "The identical backend result was reused, but its provenance was insufficient for safe occurrence suppression, so the evidence was delivered again.",
          } satisfies PaperEvidenceProgress,
          paperEvidenceReferences: cached.references,
        },
      };
    }
    const repeatedOccurrenceIds = cached.references
      .map((reference) => reference.occurrenceId)
      .filter((entry): entry is string => Boolean(entry));
    const frontier = cached.unavailable ? "unavailable" : "unchanged";
    const progress = progressFor({
      frontier,
      coverage: cached.coverage,
      newOccurrenceIds: [],
      repeatedOccurrenceIds,
      cumulativeOccurrenceCount: this.seenOccurrences.size,
      stopPolicy: this.stopPolicy,
      readsThisTurn: this.readsThisTurn,
      planExecuting: this.planExecuting,
    });
    return {
      frontier,
      content: {
        mode: paperReadMode(params.input),
        cacheStatus: "identical_call_reused",
        sourceToolCallId: cached.references[0]?.sourceToolCallId,
        paperEvidenceProgress: progress,
        paperEvidenceReferences: cached.references,
      },
    };
  }

  async processResult(params: ProcessParams): Promise<PaperEvidenceResult> {
    if (!isPaperEvidenceFrontierEligible(params.input)) {
      return { content: params.content, frontier: "advanced" };
    }
    const content = objectRecord(params.content);
    if (!content) {
      return { content: params.content, frontier: "unavailable" };
    }
    this.readsThisTurn += 1;
    const mode = paperReadMode(params.input);
    const coverage = resolveCoverage(content, mode);
    const occurrences = await collectOccurrences({
      content,
      mode,
      resourceSignature: params.resourceSignature,
    });
    const hasText = hasTextualEvidence(content);
    const uniqueOccurrences = new Map<string, Occurrence>();
    for (const occurrence of occurrences) {
      if (!occurrence.occurrenceId) continue;
      const existing = uniqueOccurrences.get(occurrence.occurrenceId);
      if (!existing) {
        uniqueOccurrences.set(occurrence.occurrenceId, occurrence);
        continue;
      }
      existing.quoteCitationIds = [
        ...new Set([
          ...existing.quoteCitationIds,
          ...occurrence.quoteCitationIds,
        ]),
      ];
    }
    const repeatedOccurrenceIds = [...uniqueOccurrences.keys()].filter((id) =>
      this.seenOccurrences.has(id),
    );
    const newOccurrences = [...uniqueOccurrences.entries()].filter(
      ([id]) => !this.seenOccurrences.has(id),
    );
    const hasUnidentifiedEvidence = occurrences.some(
      (occurrence) => !occurrence.occurrenceId && occurrence.contentHash,
    );
    const frontier: PaperEvidenceProgress["frontier"] = !hasText
      ? "unavailable"
      : newOccurrences.length || hasUnidentifiedEvidence
        ? "advanced"
        : "unchanged";
    const originalContent = params.content;
    const toolResultHandle =
      frontier === "advanced" && params.persistOriginal
        ? await params.persistOriginal(originalContent)
        : undefined;
    const newReferences: PaperEvidenceReference[] = newOccurrences.map(
      ([occurrenceId, occurrence]) => {
        const repeatedContentOccurrenceIds = occurrence.contentHash
          ? [
              ...(this.occurrencesByContentHash.get(occurrence.contentHash) ||
                []),
            ]
          : [];
        return {
          sourceToolCallId: params.toolCallId,
          displayLabel: occurrence.displayLabel,
          occurrenceId,
          contentHash: occurrence.contentHash,
          quoteCitationIds: occurrence.quoteCitationIds,
          toolResultHandle,
          ...(repeatedContentOccurrenceIds.length
            ? { repeatedContentOccurrenceIds }
            : {}),
        };
      },
    );
    const repeatedReferences = repeatedOccurrenceIds
      .map((id) => this.seenOccurrences.get(id))
      .filter((entry): entry is StoredOccurrence => Boolean(entry));
    for (const reference of newReferences) {
      if (!reference.occurrenceId) continue;
      const stored = reference as StoredOccurrence;
      this.seenOccurrences.set(reference.occurrenceId, stored);
      if (reference.contentHash) {
        const ids =
          this.occurrencesByContentHash.get(reference.contentHash) || new Set();
        ids.add(reference.occurrenceId);
        this.occurrencesByContentHash.set(reference.contentHash, ids);
      }
    }
    const repeatedQuoteCitationIds = new Set(
      repeatedReferences.flatMap((reference) => reference.quoteCitationIds),
    );
    const retainedQuoteCitationIds = new Set(
      newReferences.flatMap((reference) => reference.quoteCitationIds),
    );
    const filtered =
      repeatedOccurrenceIds.length > 0
        ? await suppressRepeatedOccurrences({
            content,
            repeatedIds: new Set(repeatedOccurrenceIds),
            mode,
            resourceSignature: params.resourceSignature,
            repeatedQuoteCitationIds,
            retainedQuoteCitationIds,
          })
        : { ...content };
    const progress = progressFor({
      frontier,
      coverage,
      newOccurrenceIds: newReferences
        .map((reference) => reference.occurrenceId)
        .filter((entry): entry is string => Boolean(entry)),
      repeatedOccurrenceIds,
      cumulativeOccurrenceCount: this.seenOccurrences.size,
      stopPolicy: this.stopPolicy,
      readsThisTurn: this.readsThisTurn,
      planExecuting: this.planExecuting,
    });
    const references = [...newReferences, ...repeatedReferences];
    const processedContent = {
      ...filtered,
      paperEvidenceProgress: progress,
      paperEvidenceReferences: references,
      ...(toolResultHandle ? { toolResultHandle } : {}),
    };
    const cacheReferences = references.length
      ? references
      : toolResultHandle
        ? [
            {
              sourceToolCallId: params.toolCallId,
              quoteCitationIds: [],
              toolResultHandle,
            },
          ]
        : [{ sourceToolCallId: params.toolCallId, quoteCitationIds: [] }];
    this.cachedCalls.set(
      await callKey(params.input, params.resourceSignature),
      {
        coverage,
        unavailable: frontier === "unavailable",
        references: cacheReferences,
        ...(hasUnidentifiedEvidence
          ? { failOpenContent: processedContent }
          : {}),
      },
    );
    return {
      content: processedContent,
      frontier,
      originalContent,
      toolResultHandle,
    };
  }
}
