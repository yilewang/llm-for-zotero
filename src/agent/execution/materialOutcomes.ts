import { loadMaterialRef } from "../documents/workflowMaterial";
import {
  listAgentRunEvents,
  listAgentRunsForConversation,
} from "../store/traceStore";
import type { AgentEvent } from "../types";
import {
  collectJournalActionIds,
  materialRefKey,
  parseMaterialRef,
} from "./checkpoint";
import type {
  DroppedMaterialOutcome,
  MaterialOutcomeEntry,
  MaterialOutcomeLedger,
} from "./types";

export type {
  DroppedMaterialOutcome,
  MaterialOutcomeEntry,
  MaterialOutcomeLedger,
  MaterialOutcomeStatus,
} from "./types";

/**
 * How far back a conversation is scanned for material outcomes.
 *
 * The ledger is derived, not stored, so the bound is what keeps a long
 * conversation's turn start cheap.
 */
export const MATERIAL_OUTCOME_RUN_LIMIT = 20;

const NOTE_WRITE_TOOL_NAME = "note_write";

/** The only event kinds the ledger replays; the rest of the trace is not read. */
const LEDGER_EVENT_TYPES = [
  "material_finalized",
  "tool_call",
  "tool_result",
] as const;

const MATERIAL_TITLE_MAX_LENGTH = 120;

/**
 * A material title is model-authored.  It is quoted inside a host-written
 * block, so strip anything that could forge a second line or close the quote
 * early, and cap the length.
 */
function quotedMaterialTitle(title: string | undefined): string {
  return (title || "")
    .replace(/[\u0000-\u001f\u007f-\u009f]+/gu, " ")
    .trim()
    .slice(0, MATERIAL_TITLE_MAX_LENGTH)
    .replace(/"/gu, '\\"');
}

type OpenEntry = {
  entry: MaterialOutcomeEntry;
  /** Position of the announcement that opened this entry, for newest-first order. */
  ordinal: number;
};

function readDocumentId(value: unknown): string | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const candidate = (value as Record<string, unknown>).documentId;
  return typeof candidate === "string" && candidate.trim()
    ? candidate.trim()
    : undefined;
}

/**
 * Replay one conversation's persisted run events into material outcomes.
 *
 * `material_finalized` opens an entry; a verified receipt naming the same
 * `MaterialRef` closes it as saved; a failed `note_write` against the same
 * document marks it as a failed write.  Events are replayed in run order, so
 * the last thing that happened to a document is the status it carries.
 */
export async function loadMaterialOutcomesForConversation(
  conversationKey: number,
  options: { limitRuns?: number } = {},
): Promise<MaterialOutcomeLedger> {
  const limitRuns = Math.max(
    1,
    Math.floor(options.limitRuns ?? MATERIAL_OUTCOME_RUN_LIMIT),
  );
  const runs = await listAgentRunsForConversation(conversationKey, {
    limit: limitRuns,
  });
  const open = new Map<string, OpenEntry>();
  let ordinal = 0;
  for (const run of runs) {
    const callArguments = new Map<string, unknown>();
    for (const record of await listAgentRunEvents(run.runId, {
      eventTypes: LEDGER_EVENT_TYPES,
    })) {
      ordinal += 1;
      const event: AgentEvent = record.payload;
      if (event.type === "tool_call") {
        // Only a note write names material this ledger cares about, so no
        // other tool's arguments -- a whole document body, for one -- are
        // held in memory while the run replays.
        if (event.name === NOTE_WRITE_TOOL_NAME)
          callArguments.set(event.callId, event.args);
        continue;
      }
      if (event.type === "material_finalized") {
        const materialRef = parseMaterialRef(event.materialRef);
        if (!materialRef) continue;
        open.set(materialRef.documentId, {
          ordinal,
          entry: {
            materialRef,
            materialKind: event.materialKind,
            materialTitle: event.materialTitle,
            runId: run.runId,
            status: "finalized",
          },
        });
        continue;
      }
      if (event.type !== "tool_result") continue;
      if (event.ok) {
        for (const receipt of event.actionReceipts || []) {
          const receiptRef = parseMaterialRef(receipt.materialRef);
          if (receipt.verification !== "verified" || !receiptRef) continue;
          const saved = open.get(receiptRef.documentId);
          if (
            !saved ||
            materialRefKey(saved.entry.materialRef) !==
              materialRefKey(receiptRef)
          )
            continue;
          // A result with receipts is persisted whole (only receipt-less
          // successes above the size bound are stored by handle), so its
          // content still names the journal action.
          const actionId = collectJournalActionIds(event.content)[0];
          saved.entry = {
            ...saved.entry,
            status: "saved",
            receiptId: receipt.id,
            ...(actionId ? { actionId } : {}),
          };
        }
        continue;
      }
      // A write that reached execution carries the frozen MaterialRef on its
      // receipts. One that failed earlier -- document resolution, lifecycle,
      // a rejected input -- has no receipt at all, so its material is named by
      // the result content or, failing that, by the call that requested it.
      const documentIds = new Set(
        (event.actionReceipts || [])
          .map((receipt) => parseMaterialRef(receipt.materialRef)?.documentId)
          .filter((documentId): documentId is string => Boolean(documentId)),
      );
      if (!documentIds.size && event.name === NOTE_WRITE_TOOL_NAME) {
        const documentId =
          readDocumentId(event.content) ||
          readDocumentId(callArguments.get(event.callId));
        if (documentId) documentIds.add(documentId);
      }
      for (const documentId of documentIds) {
        const failed = open.get(documentId);
        // A saved entry is terminal: a later failed write is a separate
        // attempt and never puts written material back on the unsaved list.
        if (!failed || failed.entry.status === "saved") continue;
        failed.entry = { ...failed.entry, status: "write_failed" as const };
      }
    }
  }

  const entries: MaterialOutcomeEntry[] = [];
  const dropped: DroppedMaterialOutcome[] = [];
  for (const { entry } of [...open.values()].sort(
    (left, right) => right.ordinal - left.ordinal,
  )) {
    try {
      const stored = await loadMaterialRef(entry.materialRef, conversationKey);
      if (!stored) {
        dropped.push({
          documentId: entry.materialRef.documentId,
          runId: entry.runId,
          reason: "The finalized material is no longer stored.",
        });
        continue;
      }
      const outsidePaperCount =
        stored.citationBundle.outsidePapers?.length || 0;
      entries.push(outsidePaperCount ? { ...entry, outsidePaperCount } : entry);
    } catch (error) {
      dropped.push({
        documentId: entry.materialRef.documentId,
        runId: entry.runId,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { entries, dropped };
}

/**
 * Where an entry that cites outside papers can have them imported. The
 * library_import guidance says why the documentId, not the DOIs; this only
 * names the call for this document.
 */
function outsidePaperImportNote(count: number | undefined): string {
  if (!count) return "";
  const papers = count === 1 ? "1 outside paper" : `${count} outside papers`;
  const them = count === 1 ? "it" : "them";
  return ` \u2014 cites ${papers}; if the user asks to import ${them}, call library_import kind:'document_citations' with this documentId`;
}

/**
 * The host block that names material the conversation finalized but never
 * saved.  Empty when every finalized material was already written.
 */
export function formatMaterialOutcomeRecoveryLines(
  entries: readonly MaterialOutcomeEntry[],
): string[] {
  const unsaved = entries.filter(
    (entry) => entry.status === "finalized" || entry.status === "write_failed",
  );
  if (!unsaved.length) return [];
  return [
    "Finalized material available (not saved as a note):",
    ...unsaved.map(
      (entry) =>
        `documentId=${entry.materialRef.documentId} version=${entry.materialRef.documentVersion} hash=${entry.materialRef.contentHash} title="${quotedMaterialTitle(entry.materialTitle)}" status=${entry.status}${
          entry.status === "write_failed"
            ? " \u2014 a previous save of this material failed"
            : ""
        }${outsidePaperImportNote(entry.outsidePaperCount)}`,
    ),
    "If the user asks to save it, call note_write with that documentId; do not regenerate it.",
  ];
}
