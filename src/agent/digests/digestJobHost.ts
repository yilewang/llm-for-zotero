/**
 * The host side of a digest part: what `task_update` runs when the model
 * declares (or declares again) a part whose effect is `digest`.
 *
 * It resolves each `item:<id>` target to its paper, reads the paper's text,
 * runs `runPaperDigestJob` with the chat turn's own model and the turn's
 * Stop signal, and publishes each paper's outcome as it lands: digest
 * evidence on the turn's outcome ledger (one checkpoint change per paper)
 * and one paper-row update built by the ledger's own digest builders.
 * Complete digests are cached in the conversation's tool-result handle
 * store, where context_read reads them by handle; failures never are.
 *
 * The worker gets the part's description as its task and the user's request
 * the part saved when it was declared (`question`) as context, so a resumed
 * part answers the original request, not "continue". Each paper's row update
 * names the part (its local id and label), so two parts over one paper stay
 * two results.
 *
 * Each completed digest is also a host-verified read of its paper: the host
 * issues one read observation for it (read mode `digest`), so a document may
 * cite a digested paper the model never read itself. Its depth is the text
 * the worker read: body for the whole text or an excerpt of 5,000 characters
 * or more, abstract below that.
 *
 * Bounds. One `task_update` call digests at most 30 papers; the rest stay
 * pending and the part is declared again to continue. A paper whose digest
 * failed runs again on at most two re-declarations in a run; after that its
 * failure is final.
 */
import type { UtilityLLMParams } from "../../utils/utilityLLM";
import {
  mapReaderCompletion,
  type ReaderAdapterFactories,
  type ReaderChoice,
  type ResolvedReader,
} from "../reader/resolveReader";
import {
  readerChoiceFromSelection,
  type ReaderEntryLookup,
} from "../reader/readerChoiceFromSelection";
import {
  resolveReaderWithFallback,
  type ReaderFallbackNote,
} from "../reader/readerFallback";
import type { PaperContextRef } from "../../shared/types";
import {
  buildDigestFailureLedgerDelta,
  buildDigestLedgerDelta,
  taskPaperDigestPartLabel,
  type TaskPaperDigestPaper,
} from "../context/taskPaperLedger";
import { getTurnPapers } from "../context/requestTurnPaperScope";
import { shortEvidenceRef } from "../context/evidenceRefTokens";
import type { TrustedReadObservation } from "../context/readObservationTypes";
import { joinReadObservations } from "../context/taskPaperLedgerRecorder";
import { canonicalJson } from "../services/libraryMutation/canonicalJson";
import { sha256Text } from "../store/journalRecoveryBlobStore";
import { applyOutcomeEvidence } from "../loop/outcomes";
import type { PdfService } from "../services/pdfService";
import {
  ReaderCompletionError,
  limitReaderCompletion,
  type ReaderCallLimiter,
} from "../../shared/readerCompletion";
import { hostReaderCallLimiter } from "../reader/readerLimiter";
import type { ZoteroGateway } from "../services/zoteroGateway";
import {
  createAgentToolResultHandleRecord,
  listAgentToolResultHandles,
  upsertAgentToolResultHandles,
  type AgentToolResultHandleRecord,
} from "../store/toolResultHandles";
import { readPaperTextForDigest } from "../tools/read/paperRead";
import type { AgentRuntimeRequest, AgentToolContext } from "../types";
import {
  DIGEST_FAILURE_REASONS,
  renderHostPaperDigests,
  runPaperDigestJob,
  type HostPaperDigest,
  type HostPaperDigestCitationSource,
  type PaperDigestCache,
  type PaperDigestFailure,
  type PaperDigestSource,
} from "./paperDigestWorker";

/** The tool name the digest cache's handle records are stored under. */
export const PAPER_DIGEST_HANDLE_TOOL = "paper_digest";

/** Parallel model calls per digest part. */
const DIGEST_CONCURRENCY = 4;

/** The most papers one `task_update` call digests; the rest stay pending. */
export const DIGEST_MAX_PAPERS_PER_CALL = 30;

/** Re-declarations that run a failed paper again before its failure is final. */
export const DIGEST_MAX_FAILURE_RETRIES = 2;

/** A digest of the whole text, or of at least this much read, is body depth. */
export const DIGEST_BODY_DEPTH_CHARS = 5_000;

/**
 * Per run (its request), per part and paper: the re-declarations that ran a
 * failed paper again. A new run, as after "continue", starts at none.
 */
const failureRetries = new WeakMap<object, Map<string, number>>();

/** The text a digest reads for one resolved paper, already cut. */
export type DigestPaperText = Pick<
  PaperDigestSource,
  "backend" | "text" | "totalCharacters"
>;

/** A digest cache that also names the handle context_read reads it by. */
export type HostPaperDigestCache = PaperDigestCache & {
  /** The handle holding `digest` for the current scope, stored if needed. */
  handleOf(digest: HostPaperDigest): Promise<string | undefined>;
};

export type DigestJobHostDeps = {
  /** The paper an `item:<id>` target names, or null when none resolves. */
  resolvePaper: (
    request: AgentRuntimeRequest,
    itemId: number,
  ) => Promise<PaperContextRef | null>;
  /** The paper's text cut to `maxChars`, or null when it has none. */
  readText: (
    paper: PaperContextRef,
    maxChars: number,
  ) => Promise<DigestPaperText | null>;
  /** Test seam forwarded to `callUtilityLLM`. */
  llmCall?: UtilityLLMParams["llmCall"];
  /** Test seam: each reader route's adapter factory. */
  readerFactories?: ReaderAdapterFactories;
  /** Test seam: where a picked API reader's model entry is looked up. */
  lookupReaderEntry?: ReaderEntryLookup;
  /** Test seam; defaults to the handle-store cache. */
  createCache?: (context: AgentToolContext) => HostPaperDigestCache;
};

/**
 * One digest part to run now, and the papers to digest. `retried` are those
 * of them the part already holds as failed, with the reason it holds: this
 * run is a retry for them.
 */
export type DigestPartRequest = {
  taskId: string;
  targets: string[];
  retried?: ReadonlyArray<{ target: string; reason: string }>;
};

/** What a digest run adds to the `task_update` result. */
export type DigestRunResult = {
  /** Rendered digests, one block per paper in scope order, then failures. */
  digests?: string;
  /**
   * Per digest: the handle context_read reads it by, and the evidence refs a
   * document cites it with.
   */
  digestHandles?: Array<{
    itemId: number;
    /** The part the digest answers, as the model names it. */
    taskId?: string;
    handle?: string;
    evidenceRefs?: string[];
  }>;
  /** The citable source of each digest, as a read tool's result names it. */
  documentEvidenceRefs?: DigestEvidenceRef[];
  /** `final`: not run again; the paper failed on every allowed retry. */
  digestFailures?: Array<{
    itemId: number;
    title?: string;
    reason: string;
    final?: true;
  }>;
  /**
   * Targets Stop, or the per-call bound, left undone; declare the part again
   * to continue them.
   */
  digestPending?: string[];
  /** What the model must know to go on: a batch left, or final failures. */
  digestNote?: string;
  /**
   * Which model read each digest, when the user picked a reader model: the
   * trace's record of who read what.
   */
  digestReaders?: Array<{
    itemId: number;
    taskId?: string;
    model: string;
    route?: string;
  }>;
  /** The chosen reader failed for a configuration reason; main model read. */
  readerFallback?: ReaderFallbackNote;
};

/** One digest's evidence ref, in the shape a read tool's result carries. */
export type DigestEvidenceRef = {
  evidenceRef: string;
  libraryID: number;
  itemKey: string;
  capabilities: TrustedReadObservation["capabilities"];
  attachmentItemKey?: string;
};

type ZoteroItemLike = {
  id?: unknown;
  key?: unknown;
  libraryID?: unknown;
  parentID?: unknown;
  isAttachment?: () => boolean;
};

/** The paper's Zotero identity, as a read observation names it. */
function digestPaperIdentity(digest: HostPaperDigest): {
  libraryID: number;
  itemKey: string;
  attachmentItemKey?: string;
} | null {
  const items = (
    globalThis as typeof globalThis & {
      Zotero?: { Items?: { get?: (id: number) => ZoteroItemLike | null } };
    }
  ).Zotero?.Items;
  if (!items?.get) return null;
  const item = items.get(digest.itemId);
  const itemKey = typeof item?.key === "string" ? item.key.trim() : "";
  const libraryID = Number(item?.libraryID);
  if (!itemKey || !Number.isInteger(libraryID) || libraryID <= 0) return null;
  const attachment =
    digest.contextItemId && digest.contextItemId !== digest.itemId
      ? items.get(digest.contextItemId)
      : null;
  const attachmentItemKey =
    typeof attachment?.key === "string" && attachment.key.trim()
      ? attachment.key.trim()
      : undefined;
  return {
    libraryID,
    itemKey,
    ...(attachmentItemKey ? { attachmentItemKey } : {}),
  };
}

/**
 * The read observation the host issues for one completed digest: the paper's
 * text was read whole or in part by the host, under a call id of its own per
 * paper. Its result digest covers the answer, the relevance and stance, the
 * evidence and the source. Its depth is body when the worker read the whole
 * text or at least 5,000 characters, else abstract. Null when the paper has
 * no Zotero identity.
 */
export async function createDigestReadObservation(params: {
  callId: string;
  digest: HostPaperDigest;
  /** The tool whose call ran the digest; `task_update` for a digest part. */
  toolName?: string;
}): Promise<TrustedReadObservation | null> {
  const identity = digestPaperIdentity(params.digest);
  if (!identity) return null;
  const { digest } = params;
  const toolName = params.toolName || "task_update";
  const inputDigest = `sha256:${await sha256Text(
    canonicalJson({
      target: `item:${digest.itemId}`,
      cacheKey: digest.cacheKey,
    }),
  )}`;
  const resultDigest = `sha256:${await sha256Text(
    canonicalJson({
      answer: digest.answer,
      relevance: digest.relevance,
      stance: digest.stance,
      evidence: digest.evidence,
      source: digest.source,
    }),
  )}`;
  const callDigest = `sha256:${await sha256Text(
    canonicalJson({
      toolName,
      callId: `${params.callId}:digest:${digest.itemId}`,
      inputDigest,
    }),
  )}`;
  const unsigned = {
    version: 1 as const,
    observationId: `${callDigest}:1`,
    issuer: "zotero_host" as const,
    toolName,
    callDigest,
    inputDigest,
    resultDigest,
    ...identity,
    capabilities: [
      digest.source.complete ||
      digest.source.readCharacters >= DIGEST_BODY_DEPTH_CHARS
        ? "body"
        : "abstract",
    ] as TrustedReadObservation["capabilities"],
    readMode: "digest",
  };
  return {
    ...unsigned,
    certificateDigest: `sha256:${await sha256Text(canonicalJson(unsigned))}`,
  };
}

type DigestCacheContent = {
  cacheKey: string;
  digest: HostPaperDigest;
  rendered: string;
};

/**
 * The schema 2 digest a handle record holds, or null. A schema 1 record (a
 * summary, from before instruction-driven digests) is never served: it stays
 * in the store, where context_read still reads its stored text.
 */
function cachedDigest(
  record: AgentToolResultHandleRecord,
): HostPaperDigest | null {
  const content = record.content as Partial<DigestCacheContent> | null;
  const digest = content?.digest;
  if (
    !content ||
    typeof content.cacheKey !== "string" ||
    !digest ||
    typeof digest !== "object" ||
    digest.schema !== 2 ||
    digest.cacheKey !== content.cacheKey ||
    typeof digest.answer !== "string" ||
    !digest.answer.trim()
  )
    return null;
  return digest;
}

/**
 * The digest cache over the conversation's tool-result handle store: one
 * record per complete digest, keyed by its cache key, whose handle
 * context_read pages. The store is read once per instance.
 */
export function createHandleStorePaperDigestCache(params: {
  conversationKey: number;
  resourceSignature?: string;
  /** The turn's handle writer; defaults to the store itself. */
  persist?: (records: AgentToolResultHandleRecord[]) => Promise<void>;
  now?: () => number;
}): HostPaperDigestCache {
  const persist = params.persist || upsertAgentToolResultHandles;
  const now = params.now || (() => Date.now());
  /** cacheKey → the handle of its record under the current scope. */
  const handles = new Map<string, string>();
  let index: Promise<Map<string, HostPaperDigest>> | null = null;
  const load = () =>
    (index ||= listAgentToolResultHandles({
      conversationKey: params.conversationKey,
      toolName: PAPER_DIGEST_HANDLE_TOOL,
    }).then((records) => {
      const digests = new Map<string, HostPaperDigest>();
      for (const record of records) {
        const digest = cachedDigest(record);
        if (!digest) continue;
        digests.set(digest.cacheKey, digest);
        if (
          (record.resourceSignature || "") === (params.resourceSignature || "")
        )
          handles.set(digest.cacheKey, record.handle);
      }
      return digests;
    }));
  const store = async (digest: HostPaperDigest) => {
    const content: DigestCacheContent = {
      cacheKey: digest.cacheKey,
      digest,
      rendered: renderHostPaperDigests([digest], []),
    };
    const record = createAgentToolResultHandleRecord({
      conversationKey: params.conversationKey,
      toolName: PAPER_DIGEST_HANDLE_TOOL,
      toolCallId: digest.cacheKey,
      resourceSignature: params.resourceSignature,
      content,
      createdAt: now(),
    });
    if (!record) return undefined;
    await persist([record]);
    handles.set(digest.cacheKey, record.handle);
    return record.handle;
  };
  return {
    get: async (key) => (await load()).get(key) || null,
    set: async (digest) => {
      // Only a complete digest is cached; the worker never hands a failure.
      if (!digest.answer.trim()) return;
      const digests = await load();
      await store(digest);
      digests.set(digest.cacheKey, digest);
    },
    handleOf: async (digest) => {
      await load();
      return handles.get(digest.cacheKey) || (await store(digest));
    },
  };
}

/**
 * Resolves papers and reads their text from Zotero: the turn's own paper
 * ref when the turn carries it, else the gateway's resolver. The gateway's
 * ref does not carry the MinerU cache directory, so it is looked up from the
 * paper's attachments, as the figure read does, and the text is read
 * exactly as the overview read picks it (MinerU `full.md`, else the PDF).
 */
export function createZoteroPaperDigestSources(deps: {
  zoteroGateway: Pick<
    ZoteroGateway,
    "resolvePaperContextTarget" | "getAllChildAttachmentInfos"
  >;
  pdfService: Pick<PdfService, "getOverviewExcerpt">;
}): Pick<DigestJobHostDeps, "resolvePaper" | "readText"> {
  return {
    resolvePaper: async (request, itemId) => {
      let paper: PaperContextRef | null = null;
      try {
        paper =
          getTurnPapers(request).find((entry) => entry.itemId === itemId) ||
          deps.zoteroGateway.resolvePaperContextTarget({ itemId });
      } catch {
        return null;
      }
      if (!paper || paper.mineruCacheDir) return paper;
      try {
        const infos =
          await deps.zoteroGateway.getAllChildAttachmentInfos(itemId);
        const match = infos.find(
          (entry) => entry.contextItemId === paper!.contextItemId,
        );
        if (match?.mineruCacheDir)
          return {
            ...paper,
            contentSourceMode: paper.contentSourceMode || "mineru",
            mineruCacheDir: match.mineruCacheDir,
          };
      } catch {
        // No MinerU directory: the PDF text is read instead.
      }
      return paper;
    },
    readText: (paper, maxChars) =>
      readPaperTextForDigest({
        paperContext: paper,
        pdfService: deps.pdfService,
        maxChars,
      }),
  };
}

/**
 * Runs each digest part's job in order, with the reader the request's
 * runtime reads with (the chat turn's model in the plugin Agent, Codex
 * Responses or the Claude bridge with the chat's model) and the turn's Stop
 * signal, publishing every paper's outcome as it lands. Stop ends the run
 * between papers: finished digests stay, and the papers not finished are
 * reported pending.
 */
export async function runDigestParts(params: {
  parts: readonly DigestPartRequest[];
  context: AgentToolContext;
  deps: DigestJobHostDeps;
  /** The part's id as the model names it. */
  localTaskId: (taskId: string) => string;
  /** An explicit reader; by default the main model of the runtime. */
  readerChoice?: ReaderChoice;
  /** Test seam; defaults to the process-wide reader limit. */
  limiter?: ReaderCallLimiter;
}): Promise<DigestRunResult> {
  const { context, deps } = params;
  const request = context.request;
  const signal = context.signal;
  const readerChoice =
    params.readerChoice ??
    readerChoiceFromSelection({
      selection: request.readerSelection,
      request,
      lookupEntry: deps.lookupReaderEntry,
    });
  const { resolution, fallbackNote } = resolveReaderWithFallback({
    request,
    choice: readerChoice,
    llmCall: deps.llmCall,
    factories: deps.readerFactories,
  });
  // No reader: every paper fails as unconfigured, without a model call.
  const unlimited: ResolvedReader = resolution.ok
    ? resolution.reader
    : {
        route: "turn_model",
        model: "",
        complete: async () => {
          throw new ReaderCompletionError({
            reason: "not_configured",
            detail: resolution.detail,
          });
        },
        windowTokens: 0,
      };
  // Every digest call waits on the host's one reader limit, as paper_digest's
  // do, so parts, chats and windows never read with more than that at once.
  const reader = mapReaderCompletion(unlimited, (complete) =>
    limitReaderCompletion(complete, params.limiter || hostReaderCallLimiter),
  );
  const inputCapTokens = reader.windowTokens;
  const cache =
    deps.createCache?.(context) ||
    createHandleStorePaperDigestCache({
      conversationKey: request.conversationKey,
      resourceSignature: context.resourceSignature,
      persist: context.persistToolResultHandles,
    });
  const papers = new Map<number, Promise<PaperContextRef | null>>();
  const resolved = new Map<number, PaperContextRef>();
  const resolvePaper = (itemId: number) => {
    let paper = papers.get(itemId);
    if (!paper) {
      paper = deps
        .resolvePaper(request, itemId)
        .catch(() => null)
        .then((ref) => {
          if (ref) resolved.set(itemId, ref);
          return ref;
        });
      papers.set(itemId, paper);
    }
    return paper;
  };
  const titleOf = (itemId: number) =>
    resolved.get(itemId)?.title ||
    request.turnScopePapers?.papers?.[itemId]?.title ||
    undefined;
  /** The paper's row identity; none without a library to key it by. */
  const ledgerPaper = (itemId: number): TaskPaperDigestPaper | null => {
    const paper = resolved.get(itemId);
    const libraryID = paper?.libraryID || request.libraryID;
    if (!libraryID || !(itemId > 0)) return null;
    const title = titleOf(itemId);
    return {
      libraryID,
      itemId,
      ...(paper?.contextItemId ? { contextItemId: paper.contextItemId } : {}),
      ...(title ? { title } : {}),
      ...(paper?.year ? { year: paper.year } : {}),
      ...(paper?.firstCreator ? { creator: paper.firstCreator } : {}),
    };
  };
  const recordEvidence = (
    taskId: string,
    done: string[],
    failed: Pick<PaperDigestFailure, "target" | "reason">[],
  ) =>
    context.updateExecutionCheckpoint?.(
      (checkpoint) =>
        applyOutcomeEvidence(
          checkpoint,
          { kind: "digest", taskId, done, failed },
          Date.now(),
        ).checkpoint,
    );

  /**
   * Digest cache key → the observation issued for that digest this call.
   * Keyed by digest, not paper: two parts over one paper are two digests.
   */
  const observations = new Map<string, TrustedReadObservation>();
  const issueObservation = async (callId: string, digest: HostPaperDigest) => {
    try {
      const observation = await createDigestReadObservation({
        callId,
        digest,
      });
      if (!observation) return [];
      observations.set(digest.cacheKey, observation);
      context.recordReadObservations?.([observation]);
      return [observation];
    } catch {
      // The digest stands; it is only not citable as a host-verified read.
      return [];
    }
  };
  const citationSourceOf = (
    _itemId: number,
    digest: HostPaperDigest,
  ): HostPaperDigestCitationSource | undefined => {
    const observation = observations.get(digest.cacheKey);
    return observation
      ? {
          libraryID: observation.libraryID,
          itemKey: observation.itemKey,
          evidenceRefs: [shortEvidenceRef(observation.observationId)],
        }
      : undefined;
  };

  const digests: HostPaperDigest[] = [];
  const failures: PaperDigestFailure[] = [];
  const pending: string[] = [];
  /** Failures not run again: their retries are spent. */
  const finalFailures: PaperDigestFailure[] = [];
  /** Targets the per-call bound left for the next declaration. */
  let deferred = 0;
  let room = DIGEST_MAX_PAPERS_PER_CALL;
  let retries = failureRetries.get(request);
  if (!retries) {
    retries = new Map();
    failureRetries.set(request, retries);
  }
  /** A part's local id, its label, and the heading its results render under. */
  const partInfo = (taskId: string) => {
    const local = params.localTaskId(taskId);
    const label = taskPaperDigestPartLabel(
      request.executionCheckpoint?.tasks.find(
        (entry) => entry.taskId === taskId,
      )?.description,
    );
    return {
      local,
      label,
      heading: `## Part ${local}${label ? `: ${label}` : ""}`,
    };
  };
  /** Each digest and failure → the part it belongs to, by object identity. */
  const partOf = new Map<object, ReturnType<typeof partInfo>>();
  for (const requested of params.parts) {
    const requestedPart = partInfo(requested.taskId);
    // Failed papers whose retries are spent stay failed, reason unchanged.
    const retried = new Map(
      (requested.retried || []).map((entry) => [entry.target, entry.reason]),
    );
    const runnable = requested.targets.filter((target) => {
      if (!retried.has(target)) return true;
      const used = retries.get(`${requested.taskId}\u0000${target}`) || 0;
      if (used < DIGEST_MAX_FAILURE_RETRIES) return true;
      const itemId = Number(/^item:(\d+)$/.exec(target)?.[1]) || 0;
      const spent: PaperDigestFailure = {
        target,
        itemId,
        reason: retried.get(target)!,
      };
      partOf.set(spent, requestedPart);
      finalFailures.push(spent);
      return false;
    });
    if (signal?.aborted) {
      pending.push(...runnable);
      continue;
    }
    const batch = runnable.slice(0, Math.max(0, room));
    pending.push(...runnable.slice(batch.length));
    deferred += runnable.length - batch.length;
    room -= batch.length;
    if (!batch.length) continue;
    for (const target of batch) {
      if (!retried.has(target)) continue;
      const key = `${requested.taskId}\u0000${target}`;
      retries.set(key, (retries.get(key) || 0) + 1);
    }
    const part = { ...requested, targets: batch };
    const { local, label } = requestedPart;
    const base = context.toolCallId || `${context.runId || "run"}:${local}`;
    // One call id per part, so two parts over one paper both apply.
    const callId = params.parts.length > 1 ? `${base}:${local}` : base;
    const task = request.executionCheckpoint?.tasks.find(
      (entry) => entry.taskId === part.taskId,
    );
    const instruction = task?.description || "";
    // The paper rows name the part: its full task id, so two runs of one
    // conversation that both declare a part 'papers' stay two parts, and its
    // label.
    const partRow = { partId: part.taskId, ...(label ? { label } : {}) };
    const result = await runPaperDigestJob({
      targets: part.targets,
      instruction,
      ...(task?.question ? { question: task.question } : {}),
      readText: async (itemId, maxChars) => {
        const paper = await resolvePaper(itemId);
        if (!paper) return null;
        const text = await deps.readText(paper, maxChars);
        if (!text) return null;
        return {
          itemId,
          contextItemId: paper.contextItemId,
          ...(paper.libraryID ? { libraryID: paper.libraryID } : {}),
          ...(paper.title ? { title: paper.title } : {}),
          ...text,
        };
      },
      reader,
      inputCapTokens,
      concurrency: DIGEST_CONCURRENCY,
      signal,
      cache,
      onDigest: async (digest, target) => {
        await recordEvidence(part.taskId, [target], []);
        const issued = await issueObservation(callId, digest);
        const paper = ledgerPaper(digest.itemId);
        if (!paper) return;
        const delta = buildDigestLedgerDelta({
          runId: context.runId,
          callId,
          toolName: "task_update",
          ...partRow,
          digest,
          paper,
        });
        // The paper's row names the observation a document cites it by.
        if (issued.length) joinReadObservations(delta, issued);
        await context.publishPaperLedgerDelta?.(delta);
      },
      onFailure: async (failure) => {
        await recordEvidence(
          part.taskId,
          [],
          [{ target: failure.target, reason: failure.reason }],
        );
        const paper = ledgerPaper(failure.itemId);
        if (!paper) return;
        await context.publishPaperLedgerDelta?.(
          buildDigestFailureLedgerDelta({
            runId: context.runId,
            callId,
            toolName: "task_update",
            ...partRow,
            failure,
            paper,
          }),
        );
      },
    });
    for (const entry of [...result.digests, ...result.failures]) {
      partOf.set(entry, requestedPart);
    }
    digests.push(...result.digests);
    failures.push(...result.failures);
    pending.push(...result.pending);
  }

  const handles: NonNullable<DigestRunResult["digestHandles"]> = [];
  /** Digest cache key → its handle; two parts over one paper have two. */
  const handleByDigest = new Map<string, string>();
  const evidenceRefs: DigestEvidenceRef[] = [];
  for (const digest of digests) {
    let handle: string | undefined;
    try {
      handle = await cache.handleOf(digest);
    } catch {
      // The digest stays in the result; only its handle is missing.
    }
    const observation = observations.get(digest.cacheKey);
    const ref = observation
      ? shortEvidenceRef(observation.observationId)
      : undefined;
    if (observation && ref)
      evidenceRefs.push({
        evidenceRef: ref,
        libraryID: observation.libraryID,
        itemKey: observation.itemKey,
        capabilities: observation.capabilities,
        ...(observation.attachmentItemKey
          ? { attachmentItemKey: observation.attachmentItemKey }
          : {}),
      });
    if (handle) handleByDigest.set(digest.cacheKey, handle);
    const part = partOf.get(digest);
    if (handle || ref)
      handles.push({
        itemId: digest.itemId,
        ...(part ? { taskId: part.local } : {}),
        ...(handle ? { handle } : {}),
        ...(ref ? { evidenceRefs: [ref] } : {}),
      });
  }
  const allFailures = [...failures, ...finalFailures];
  const final = new Set(finalFailures);
  const notes: string[] = [];
  if (deferred)
    notes.push(
      `This call digested ${DIGEST_MAX_PAPERS_PER_CALL} papers, the most one call digests; ${deferred} ${
        deferred === 1 ? "paper is" : "papers are"
      } left (digestPending). Call task_update again with the same taskId and no description to digest the next batch.`,
    );
  // A paper with no text has nothing a retry, a read or a search can add;
  // live runs spent rounds on all three.
  const unreadable = [
    ...new Map(
      allFailures
        .filter((failure) => failure.reason === DIGEST_FAILURE_REASONS.noText)
        .map((failure) => [failure.itemId, failure]),
    ).values(),
  ];
  if (unreadable.length)
    notes.push(
      `No readable text: ${unreadable
        .map(
          (failure) =>
            `${titleOf(failure.itemId) || `Item ${failure.itemId}`} (${failure.target})`,
        )
        .join(
          ", ",
        )}. Name ${unreadable.length === 1 ? "it" : "them"} as not read; do not declare ${unreadable.length === 1 ? "it" : "them"} again, read ${unreadable.length === 1 ? "it" : "them"} with paper_read, or search for ${unreadable.length === 1 ? "it" : "them"} outside the library.`,
    );
  const retriable = finalFailures.filter(
    (failure) => failure.reason !== DIGEST_FAILURE_REASONS.noText,
  );
  if (retriable.length)
    notes.push(
      `Not run again: ${retriable
        .map(
          (failure) =>
            `${titleOf(failure.itemId) || `Item ${failure.itemId}`} (${failure.target})`,
        )
        .join(", ")}. ${
        retriable.length === 1 ? "Its digest" : "Their digests"
      } already failed after ${DIGEST_MAX_FAILURE_RETRIES} retries, so the failure is final with the reason given. Read such a paper with paper_read mode:'overview' if the work needs it, or name it as not read.`,
    );
  // A paper judged unrelated is the model's to keep or leave out; the note
  // names how to leave it out, at the moment the model decides.
  const unrelated = [
    ...new Map(
      digests
        .filter((digest) => digest.relevance?.level === "none")
        .map((digest) => [digest.itemId, digest]),
    ).values(),
  ];
  if (unrelated.length)
    notes.push(
      `Judged unrelated to the request: ${unrelated
        .map(
          (digest) =>
            `${titleOf(digest.itemId) || digest.title || `Item ${digest.itemId}`} (item:${digest.itemId})`,
        )
        .join(
          ", ",
        )}. Use a paper in a synthesis only where its content bears on the request; never stretch one in by analogy. If its content does not bear on the request, leave it out with excluded:[{ targetIds:['item:N'], reason:'<one sentence>' }] in submit_document, or in task_update with the answer part's taskId, and name it by title with that reason in the output, without a citation. When the user asked for every paper, keep its result and flag the mismatch instead.`,
    );
  return {
    ...(digests.length || allFailures.length
      ? {
          digests: renderHostPaperDigests(
            digests,
            allFailures,
            titleOf,
            citationSourceOf,
            (_itemId, digest) => handleByDigest.get(digest.cacheKey),
            // With two parts, each result names the part it answers.
            params.parts.length > 1
              ? (entry) => partOf.get(entry)?.heading
              : undefined,
          ),
        }
      : {}),
    ...(handles.length ? { digestHandles: handles } : {}),
    ...(evidenceRefs.length ? { documentEvidenceRefs: evidenceRefs } : {}),
    ...(allFailures.length
      ? {
          digestFailures: allFailures.map((failure) => {
            const title = titleOf(failure.itemId);
            return {
              itemId: failure.itemId,
              ...(title ? { title } : {}),
              reason: failure.reason,
              ...(final.has(failure) ? { final: true as const } : {}),
            };
          }),
        }
      : {}),
    ...(pending.length ? { digestPending: pending } : {}),
    ...(notes.length ? { digestNote: notes.join(" ") } : {}),
    ...(readerChoice && digests.length
      ? {
          digestReaders: digests.map((digest) => ({
            itemId: digest.itemId,
            ...(partOf.get(digest)
              ? { taskId: partOf.get(digest)!.local }
              : {}),
            model: digest.model,
            ...(digest.readerRoute ? { route: digest.readerRoute } : {}),
          })),
        }
      : {}),
    ...(fallbackNote() ? { readerFallback: fallbackNote() } : {}),
  };
}
