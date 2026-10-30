/**
 * paper_digest: the host's per-paper reader for Codex and Claude Code, over
 * MCP. The plugin Agent declares a `task_update` digest part instead; both
 * run the one digest worker (`digests/paperDigestWorker.ts`).
 *
 * Each call reads up to `PAPER_DIGEST_MAX_PAPERS_PER_CALL` papers, each
 * from its text up to `DIGEST_TEXT_MAX_CHARS` (in batches when it is long;
 * a longer item's digest is partial), with the chat's own
 * model through its runtime's tool-free route (`reader/resolveReader.ts`),
 * and returns one row per paper: the digest, or why it failed. The rest are
 * returned as `pending`, and the next call continues them; finished papers
 * come from the conversation's digest cache and are never read twice.
 *
 * It is a read: the MCP server attests its rows (`createTrustedReadObservations`)
 * and records them in Task progress (`attestAndRecordRead`), one row per
 * paper, so a document may cite a digested paper the agent never opened.
 *
 * Bounds that span calls live per run (the chat's conversation key and the
 * scope's run id, so two chats never share them) and end with the run: the
 * papers already returned, which a repeat returns again from memory (flagged
 * `alreadyReturned`, never read again and never recorded again), the failed
 * papers' retries, at most two, and the failures already reported (flagged
 * `alreadyReported`, so a repeat call adds no second ledger row). All reader calls of
 * the MCP host share one limit (`PAPER_DIGEST_READER_CALL_LIMIT`), however
 * many calls and papers run at once.
 */
import type { AgentToolContext, AgentToolDefinition } from "../../types";
import type { PaperContextRef } from "../../../shared/types";
import { fail, ok, validateObject } from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import { fnv1a32Raw } from "../../../utils/fnv1a";
import {
  limitReaderCompletion,
  type ReaderCallLimiter,
} from "../../../shared/readerCompletion";
import {
  HOST_READER_CALL_LIMIT,
  hostReaderCallLimiter,
} from "../../reader/readerLimiter";
import {
  mapReaderCompletion,
  type ReaderAdapterFactories,
  type ReaderChoice,
} from "../../reader/resolveReader";
import {
  readerChoiceFromSelection,
  type ReaderEntryLookup,
} from "../../reader/readerChoiceFromSelection";
import {
  resolveReaderWithFallback,
  type ReaderFallbackNote,
} from "../../reader/readerFallback";
import {
  DIGEST_FAILURE_REASONS,
  DIGEST_TEXT_MAX_CHARS,
  digestSourceLabel,
  runPaperDigestJob,
  withoutDigestQuoteCitations,
  type HostPaperDigest,
  type PaperDigestCache,
  type PaperDigestFailure,
} from "../../digests/paperDigestWorker";
import {
  DIGEST_MAX_FAILURE_RETRIES,
  createHandleStorePaperDigestCache,
  type DigestJobHostDeps,
} from "../../digests/digestJobHost";
import { taskPaperDigestPartLabel } from "../../context/taskPaperLedger";

export const PAPER_DIGEST_TOOL_NAME = "paper_digest";

/**
 * The most papers one call reads; the rest are pending. Sized so one call
 * fits the MCP tool timeout (`ZOTERO_MCP_TOOL_TIMEOUT_SEC`): eight papers,
 * four at a time, is two rounds of reader calls.
 */
export const PAPER_DIGEST_MAX_PAPERS_PER_CALL = 8;

/** The most papers one call may name, as a digest part. */
export const PAPER_DIGEST_MAX_TARGETS = 200;

/**
 * Reader calls in flight at once across every paper_digest call (and the
 * native paper_read full reads): the host's one shared limit.
 */
export const PAPER_DIGEST_READER_CALL_LIMIT = HOST_READER_CALL_LIMIT;

/** Papers of one call read at once (bounded again by the shared limit). */
const PAPER_DIGEST_CONCURRENCY = 4;

/** Runs whose bounds are kept; the oldest is dropped past this. */
const MAX_TRACKED_RUNS = 32;

/** Why a target outside the chat's library was not read. */
export const PAPER_DIGEST_OTHER_LIBRARY = "Not a paper of this chat's library";

/** Why a target whose library cannot be determined was not read. */
export const PAPER_DIGEST_LIBRARY_UNKNOWN =
  "The paper's library could not be determined";

export type PaperDigestInput = {
  /** `item:<id>` targets, in the caller's order, without repeats. */
  targets: string[];
  instruction: string;
  question?: string;
};

type DigestedFields = Omit<
  HostPaperDigest,
  "schema" | "cacheKey" | "producedAt"
>;

type DigestedRow = {
  status: "digested";
  libraryID?: number;
  /** An earlier call of this run returned this digest; the body is repeated. */
  alreadyReturned?: true;
} & DigestedFields;

type RunBounds = {
  /** Digests already returned this run, by target key, with their body. */
  returned: Map<string, DigestedRow>;
  /** Failed papers: their last reason and the retries already run. */
  failures: Map<string, { reason: string; retries: number }>;
  /** Targets whose failure an earlier call of this run reported, with the reason reported. */
  reported: Map<string, string>;
};

/** Bounds by `<conversation key> <run id>`: two chats never share a run. */
const runBounds = new Map<string, RunBounds>();

const boundsKey = (conversationKey: number, runId: string) =>
  `${conversationKey}\u0000${runId}`;

/**
 * Ends a run's bounds; the next call of that run id starts fresh. Without a
 * run id, every run ends; with one, that run id ends in every chat.
 */
export function clearPaperDigestRunBounds(runId?: string): void {
  if (runId === undefined) runBounds.clear();
  else
    for (const key of [...runBounds.keys()])
      if (key.endsWith(`\u0000${runId}`)) runBounds.delete(key);
}

/** Run ids whose bounds are held now (test seam). */
export function trackedPaperDigestRuns(): string[] {
  return [...runBounds.keys()].map((key) => key.split("\u0000")[1]);
}

function boundsFor(
  conversationKey: number,
  runId: string,
  signal?: AbortSignal,
): RunBounds {
  const key = boundsKey(conversationKey, runId);
  let bounds = runBounds.get(key);
  if (bounds) return bounds;
  bounds = { returned: new Map(), failures: new Map(), reported: new Map() };
  runBounds.set(key, bounds);
  // The scope's signal ends with its turn: the run's bounds end with it.
  signal?.addEventListener("abort", () => void runBounds.delete(key), {
    once: true,
  });
  while (runBounds.size > MAX_TRACKED_RUNS) {
    const oldest = runBounds.keys().next().value;
    if (oldest === undefined) break;
    runBounds.delete(oldest);
  }
  return bounds;
}

export type PaperDigestToolDeps = Pick<
  DigestJobHostDeps,
  "resolvePaper" | "readText"
> & {
  /** Test seam; defaults to the conversation's handle-store cache. */
  createCache?: (context: AgentToolContext) => PaperDigestCache;
  /** Test seam: each reader route's adapter factory. */
  readerFactories?: ReaderAdapterFactories;
  /** Test seam; defaults to the process-wide limit. */
  limiter?: ReaderCallLimiter;
  /** Test seam: the retry pause. */
  wait?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /**
   * An explicit reader; by default the one the request's `readerSelection`
   * names, else the main model of the runtime.
   */
  readerChoice?: (context: AgentToolContext) => ReaderChoice | undefined;
  /** Test seam: where a picked API reader's model entry is looked up. */
  lookupReaderEntry?: ReaderEntryLookup;
};

function normalizeTarget(value: unknown): string | null {
  const raw =
    typeof value === "number"
      ? String(value)
      : typeof value === "string"
        ? value.trim()
        : "";
  const match = /^(?:item:)?(\d+)$/.exec(raw);
  if (!match) return null;
  const itemId = Number(match[1]);
  return Number.isSafeInteger(itemId) && itemId > 0 ? `item:${itemId}` : null;
}

function validatePaperDigestInput(args: unknown) {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail<PaperDigestInput>("paper_digest expects an object input");
  }
  if (!Array.isArray(args.targets) || !args.targets.length) {
    return fail<PaperDigestInput>(
      "targets must name at least one paper as 'item:<itemId>'",
    );
  }
  const targets: string[] = [];
  for (const entry of args.targets) {
    const target = normalizeTarget(entry);
    if (!target) {
      return fail<PaperDigestInput>(
        `targets must be 'item:<itemId>' strings or item ids; got ${JSON.stringify(entry)}`,
      );
    }
    if (!targets.includes(target)) targets.push(target);
  }
  if (targets.length > PAPER_DIGEST_MAX_TARGETS) {
    return fail<PaperDigestInput>(
      `One call names at most ${PAPER_DIGEST_MAX_TARGETS} papers; screen the papers first, or split the list.`,
    );
  }
  const instruction =
    typeof args.instruction === "string" ? args.instruction.trim() : "";
  if (!instruction) {
    return fail<PaperDigestInput>(
      "instruction must say what to find in each paper",
    );
  }
  const question =
    typeof args.question === "string" && args.question.trim()
      ? args.question.trim()
      : undefined;
  return ok<PaperDigestInput>({
    targets,
    instruction,
    ...(question ? { question } : {}),
  });
}

/** A per-call cache, for a client with no conversation to cache in. */
function memoryCache(): PaperDigestCache {
  const entries = new Map<string, HostPaperDigest>();
  return {
    get: async (key) => entries.get(key) || null,
    set: async (digest) => void entries.set(digest.cacheKey, digest),
  };
}

function itemIdOf(target: string): number {
  return Number(/^item:(\d+)$/.exec(target)?.[1]) || 0;
}

type DigestRow =
  | DigestedRow
  | {
      status: "failed";
      itemId: number;
      title?: string;
      reason: string;
      /** Not run again: its retries in this run are spent. */
      final?: true;
      /** An earlier call of this run reported this failure; no new record. */
      alreadyReported?: true;
    };

export type PaperDigestResult = {
  /** The instruction's label, as a digest part's paper rows name it. */
  label?: string;
  status: "complete" | "partial";
  /** One row per named paper that is not pending, in the caller's order. */
  papers: DigestRow[];
  /** Targets left for the next call. */
  pending?: string[];
  note?: string;
  /** The chosen reader failed for a configuration reason; main model read. */
  readerFallback?: ReaderFallbackNote;
};

function titled(title: string | undefined, target: string): string {
  return title ? `${title} (${target})` : target;
}

export async function executePaperDigest(
  input: PaperDigestInput,
  context: AgentToolContext,
  deps: PaperDigestToolDeps,
): Promise<PaperDigestResult> {
  const request = context.request;
  if (request.executionContext?.permissionOwner === "original_agent") {
    throw new Error(
      "paper_digest serves Codex and Claude Code over MCP; in the plugin Agent, declare a task_update digest part instead.",
    );
  }
  const { resolution, fallbackNote } = resolveReaderWithFallback({
    request,
    choice: deps.readerChoice
      ? deps.readerChoice(context)
      : readerChoiceFromSelection({
          selection: request.readerSelection,
          request,
          lookupEntry: deps.lookupReaderEntry,
        }),
    factories: deps.readerFactories,
  });
  if (!resolution.ok) throw new Error(resolution.detail);
  const limiter = deps.limiter || hostReaderCallLimiter;
  // The reader keeps its model live: a fallback to the main model shows on
  // the digests it reads.
  const reader = mapReaderCompletion(resolution.reader, (complete) =>
    limitReaderCompletion(complete, limiter),
  );
  const runId = context.runId || "run";
  const bounds = boundsFor(request.conversationKey || 0, runId, context.signal);
  const scope = `${fnv1a32Raw(input.instruction).toString(16)}:${fnv1a32Raw(
    input.question || "",
  ).toString(16)}`;
  const keyOf = (target: string) => `${scope}\u0000${target}`;

  const resolved = new Map<number, PaperContextRef | null>();
  const resolvePaper = async (itemId: number) => {
    if (!resolved.has(itemId)) {
      let paper: PaperContextRef | null = null;
      try {
        paper = await deps.resolvePaper(request, itemId);
      } catch {
        paper = null;
      }
      resolved.set(itemId, paper);
    }
    return resolved.get(itemId) || null;
  };
  const titleOf = (itemId: number) => resolved.get(itemId)?.title || undefined;

  const rows = new Map<string, DigestRow>();
  /**
   * A failed row; a repeat of a failure the run reported, with the same
   * reason, is flagged. A changed reason is a new record.
   */
  const failedRow = (
    target: string,
    itemId: number,
    reason: string,
    extra: { final?: true } = {},
  ): DigestRow => {
    const key = keyOf(target);
    const alreadyReported = bounds.reported.get(key) === reason;
    bounds.reported.set(key, reason);
    const title = titleOf(itemId);
    return {
      status: "failed",
      itemId,
      ...(title ? { title } : {}),
      reason,
      ...extra,
      ...(alreadyReported ? { alreadyReported: true as const } : {}),
    };
  };
  const runnable: string[] = [];
  for (const target of input.targets) {
    const itemId = itemIdOf(target);
    const key = keyOf(target);
    const returned = bounds.returned.get(key);
    if (returned) {
      // The digest again, for a client whose context lost it; it records
      // nothing new and does not count toward the call's papers.
      rows.set(target, { ...returned, alreadyReturned: true });
      continue;
    }
    const failed = bounds.failures.get(key);
    if (failed && failed.retries >= DIGEST_MAX_FAILURE_RETRIES) {
      await resolvePaper(itemId);
      rows.set(
        target,
        failedRow(target, itemId, failed.reason, { final: true }),
      );
      continue;
    }
    runnable.push(target);
  }

  // The chat's library is the scope: a paper of another library, or one whose
  // library cannot be determined, is refused and not read. A refused paper
  // takes no place among the papers one call reads.
  const readable: string[] = [];
  const deferred: string[] = [];
  for (const target of runnable) {
    if (readable.length >= PAPER_DIGEST_MAX_PAPERS_PER_CALL) {
      deferred.push(target);
      continue;
    }
    const itemId = itemIdOf(target);
    const paper = await resolvePaper(itemId);
    if (!paper?.libraryID || !request.libraryID) {
      rows.set(target, failedRow(target, itemId, PAPER_DIGEST_LIBRARY_UNKNOWN));
      continue;
    }
    if (paper.libraryID !== request.libraryID) {
      rows.set(target, failedRow(target, itemId, PAPER_DIGEST_OTHER_LIBRARY));
      continue;
    }
    const failed = bounds.failures.get(keyOf(target));
    if (failed) failed.retries += 1;
    readable.push(target);
  }

  const cache =
    deps.createCache?.(context) ||
    (request.conversationKey > 0
      ? createHandleStorePaperDigestCache({
          conversationKey: request.conversationKey,
        })
      : memoryCache());
  const job = readable.length
    ? await runPaperDigestJob({
        targets: readable,
        instruction: input.instruction,
        ...(input.question ? { question: input.question } : {}),
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
            sourceLabel: digestSourceLabel(paper),
            ...text,
          };
        },
        reader,
        inputCapTokens: reader.windowTokens,
        concurrency: PAPER_DIGEST_CONCURRENCY,
        signal: context.signal,
        cache,
        ...(deps.wait ? { wait: deps.wait } : {}),
        // The MCP server records the rows once the call returns.
        onDigest: async () => undefined,
        onFailure: async () => undefined,
      })
    : { digests: [], failures: [], pending: [], publishErrors: 0 };

  for (const digest of job.digests) {
    const target = `item:${digest.itemId}`;
    bounds.failures.delete(keyOf(target));
    const paper = resolved.get(digest.itemId);
    const {
      schema: _schema,
      cacheKey: _cacheKey,
      producedAt: _producedAt,
      ...fields
    } = digest;
    const row: DigestedRow = {
      status: "digested",
      ...(paper?.libraryID ? { libraryID: paper.libraryID } : {}),
      ...fields,
    };
    bounds.returned.set(keyOf(target), row);
    rows.set(target, row);
  }
  for (const failure of job.failures as PaperDigestFailure[]) {
    const key = keyOf(failure.target);
    const prior = bounds.failures.get(key);
    bounds.failures.set(key, {
      reason: failure.reason,
      retries: prior?.retries ?? 0,
    });
    rows.set(
      failure.target,
      failedRow(failure.target, failure.itemId, failure.reason),
    );
  }

  const pendingSet = new Set([...deferred, ...job.pending]);
  const pending = input.targets.filter((target) => pendingSet.has(target));
  const papers = input.targets.flatMap((target) => {
    const row = rows.get(target);
    return row && !pendingSet.has(target) ? [row] : [];
  });

  const notes: string[] = [];
  if (deferred.length) {
    notes.push(
      `This call read ${readable.length} papers, the most one call reads; ${deferred.length} ${
        deferred.length === 1 ? "paper is" : "papers are"
      } pending. Call paper_digest again with the same instruction and question to read the next ${PAPER_DIGEST_MAX_PAPERS_PER_CALL}; papers already digested are not read again.`,
    );
  }
  if (job.pending.length) {
    notes.push(
      "The run was stopped before every paper was read; the papers not read are pending.",
    );
  }
  const repeated = papers.filter(
    (row) => row.status === "digested" && "alreadyReturned" in row,
  ).length;
  if (repeated) {
    notes.push(
      `${repeated} ${repeated === 1 ? "paper was" : "papers were"} already digested by an earlier paper_digest call in this run (alreadyReturned); ${
        repeated === 1 ? "its digest is" : "their digests are"
      } repeated here, not read again, and add nothing new to the record.`,
    );
  }
  const unreadable = papers.filter(
    (row) =>
      row.status === "failed" && row.reason === DIGEST_FAILURE_REASONS.noText,
  );
  if (unreadable.length) {
    notes.push(
      `No readable text: ${unreadable
        .map((row) => titled(row.title, `item:${row.itemId}`))
        .join(", ")}. Name ${
        unreadable.length === 1 ? "it" : "them"
      } as not read; do not digest ${unreadable.length === 1 ? "it" : "them"} again.`,
    );
  }
  const finalFailures = papers.filter(
    (row) =>
      row.status === "failed" &&
      row.final &&
      row.reason !== DIGEST_FAILURE_REASONS.noText,
  );
  if (finalFailures.length) {
    notes.push(
      `Not run again: ${finalFailures
        .map((row) => titled(row.title, `item:${row.itemId}`))
        .join(", ")}. ${
        finalFailures.length === 1 ? "Its digest" : "Their digests"
      } already failed after ${DIGEST_MAX_FAILURE_RETRIES} retries; read such a paper with paper_read mode:'overview' if the work needs it, or name it as not read.`,
    );
  }
  const label = taskPaperDigestPartLabel(input.instruction);
  return {
    ...(label ? { label } : {}),
    status: pending.length ? "partial" : "complete",
    papers,
    ...(pending.length ? { pending } : {}),
    ...(notes.length ? { note: notes.join(" ") } : {}),
    ...(fallbackNote() ? { readerFallback: fallbackNote() } : {}),
  };
}

/** The long-item setting as the description states it, e.g. "250,000". */
const DIGEST_TEXT_MAX_CHARS_LABEL = String(DIGEST_TEXT_MAX_CHARS).replace(
  /\B(?=(\d{3})+(?!\d))/g,
  ",",
);

export function createPaperDigestTool(
  deps: PaperDigestToolDeps,
): AgentToolDefinition<PaperDigestInput, PaperDigestResult> {
  return {
    spec: {
      name: PAPER_DIGEST_TOOL_NAME,
      description: [
        `Digest papers with the host's reader: it reads up to ${DIGEST_TEXT_MAX_CHARS_LABEL} characters of each paper with this chat's own model (in batches when long) and returns per paper the answer to \`instruction\`, relevance and stance when a question or claim is named, facets, verified quotes, gaps, and source.complete.`,
        "A longer item, such as a book or a thesis, is read only up to that limit and comes back with source.complete false; paper_read mode:'full' reads a whole text when the user asks for it.",
        `One call reads at most ${PAPER_DIGEST_MAX_PAPERS_PER_CALL} papers; the rest come back in \`pending\`: call again with the same instruction and question until nothing is pending (digested papers are not read again).`,
        "A failed paper runs again on at most two later calls.",
        "Cite a verified quote in chat by its quoteCitationId; the evidence refs are for submit_document.",
        "Apart from a whole text the user asks for, read a digested paper again only with paper_read mode:'targeted', to check a decisive claim, test a contradiction, find a precise location, or close a gap its digest names.",
      ].join(" "),
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["targets", "instruction"],
        properties: {
          targets: {
            type: "array",
            minItems: 1,
            maxItems: PAPER_DIGEST_MAX_TARGETS,
            description:
              "The papers, as 'item:<itemId>' (or the item id), in the order to read them.",
            items: { anyOf: [{ type: "string" }, { type: "integer" }] },
          },
          instruction: {
            type: "string",
            description:
              "What to find in each paper, e.g. 'For the review question \"<question>\": summarize each paper and judge how it bears on the question'.",
          },
          question: {
            type: "string",
            description:
              "The user's request the digests serve, read as context. Pass the same value on every call of one review.",
          },
        },
      },
      executionClass: "read",
      workCategory: "retrieval",
      exposure: "model",
    },
    /**
     * For Codex and Claude Code over MCP only: the plugin Agent declares a
     * task_update digest part, and a client without a native runtime has
     * no reader model.
     */
    isAvailable: (request) =>
      request.executionContext?.permissionOwner === "external_runtime" &&
      (request.exhaustiveReadBackend === "codex_responses" ||
        request.exhaustiveReadBackend === "claude_bridge"),
    validate: validatePaperDigestInput,
    // The model cites a row's quote by the id beside it; the citation
    // records ride on the call's activity to the panel.
    modelContent: (result) => withoutDigestQuoteCitations(result),
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        effects: ["read"],
        reason:
          "Read the named papers' text with the chat's own model; changes no library data.",
      }),
    execute: (input, context) => executePaperDigest(input, context, deps),
    presentation: {
      label: "Digest Papers",
      summaries: {
        onCall: ({ args }) => {
          const targets =
            args && typeof args === "object"
              ? (args as { targets?: unknown }).targets
              : undefined;
          const count = Array.isArray(targets)
            ? Math.min(targets.length, PAPER_DIGEST_MAX_PAPERS_PER_CALL)
            : 0;
          return count === 1
            ? "Reading 1 paper"
            : count
              ? `Reading ${count} papers`
              : "Reading papers";
        },
        onSuccess: ({ content }) => {
          const result = content as Partial<PaperDigestResult> | null;
          const done = (result?.papers || []).filter(
            (row) => row.status === "digested",
          ).length;
          const pending = result?.pending?.length || 0;
          const base =
            done === 1 ? "Digested 1 paper" : `Digested ${done} papers`;
          return pending ? `${base}, ${pending} pending` : base;
        },
      },
    },
  };
}
