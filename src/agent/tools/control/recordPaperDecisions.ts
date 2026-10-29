import type {
  AgentToolDefinition,
  AgentToolInputValidation,
} from "../../types";
import { fail, ok, validateObject } from "../shared";
import { readOnlyInvocationPlan } from "../../authorization/invocationPlan";
import type {
  TaskPaperDecision,
  TaskPaperDecisionInput,
  TaskPaperDigestPaper,
} from "../../context/taskPaperLedger";

/**
 * record_paper_decisions: the agent states, for each paper, whether the task
 * includes, excludes or defers it, and why. The decisions are the agent's
 * claims, kept apart from verified reads: the host's ledger recorder turns
 * the result's `paperDecisions` into the call's `paper_ledger_update`
 * (taskPaperLedgerRecorder.ts), in the built-in runtime and over MCP, so they
 * reach Task progress and the conversation's stored trace like a read does.
 *
 * Each row names a paper by its Zotero item id. A row is refused when the id
 * names no item, an item in another library than the turn's, or an item that
 * is not a paper (a note, a file without a parent item, a paper in the
 * trash); a child attachment stands for its paper. A paper named twice in
 * one call keeps its last row. The same call replayed changes nothing, and
 * a later call replaces a paper's decision (taskPaperLedger.ts).
 *
 * It changes only plugin state, so it is a control tool with a read-only
 * invocation plan, auto-approved, as past_chat_attach.
 */

export const RECORD_PAPER_DECISIONS_TOOL_NAME = "record_paper_decisions";
/** Rows one call takes: a screening batch. */
export const RECORD_PAPER_DECISIONS_MAX_ROWS = 200;
/** Refused rows a result lists; the rest are counted. */
const MAX_LISTED_REJECTIONS = 20;

/** A Zotero item id as the read tools and task_update take it. */
const PAPER_TARGET = /^(?:item:)?([1-9]\d*)$/;

const DECISIONS: ReadonlyArray<TaskPaperDecision["value"]> = [
  "include",
  "exclude",
  "defer",
];
const RELEVANCE: ReadonlyArray<NonNullable<TaskPaperDecision["relevance"]>> = [
  "high",
  "medium",
  "low",
  "none",
];

const NO_CONVERSATION =
  "Decisions can be recorded only in a conversation in Zotero.";
const NO_LIBRARY = "This turn has no library to record decisions in.";
const NOT_FOUND = "No item with this id.";
const OTHER_LIBRARY = "This item is in another library.";
const NOT_PAPER = "This item is not a paper.";
const IN_TRASH = "This paper is in the trash.";

/** The item lookups a decision's paper is resolved through (ZoteroGateway). */
export type PaperDecisionLookup = {
  getItem(itemId: number | undefined): Zotero.Item | null;
  resolveBibliographicItem(
    item: Zotero.Item | null | undefined,
  ): Zotero.Item | null;
};

/** The item id a target names, or undefined when it names none. */
export function paperDecisionTargetId(value: unknown): number | undefined {
  const text =
    typeof value === "number" ? String(value) : String(value ?? "").trim();
  const match = PAPER_TARGET.exec(text);
  return match ? Number(match[1]) : undefined;
}

function fieldOf(item: Zotero.Item, field: string): string | undefined {
  try {
    const value = item.getField?.(field);
    return typeof value === "string" && value.trim() ? value.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The paper an item id names in the turn's library, with the record the
 * paper's row shows, or why it names none.
 */
export function resolveDecisionPaper(
  itemId: number,
  libraryID: number,
  lookup: PaperDecisionLookup,
): { ok: true; paper: TaskPaperDigestPaper } | { ok: false; reason: string } {
  let item: Zotero.Item | null;
  let paper: Zotero.Item | null;
  try {
    item = lookup.getItem(itemId);
    if (!item) return { ok: false, reason: NOT_FOUND };
    if (Number(item.libraryID) !== libraryID)
      return { ok: false, reason: OTHER_LIBRARY };
    paper = lookup.resolveBibliographicItem(item);
  } catch {
    return { ok: false, reason: NOT_FOUND };
  }
  if (!paper || Number(paper.libraryID) !== libraryID)
    return { ok: false, reason: NOT_PAPER };
  if ((paper as { deleted?: unknown }).deleted === true)
    return { ok: false, reason: IN_TRASH };
  const paperId = Number(paper.id);
  if (!Number.isInteger(paperId) || paperId <= 0)
    return { ok: false, reason: NOT_PAPER };
  const resolved: TaskPaperDigestPaper = { libraryID, itemId: paperId };
  if (paperId !== itemId) resolved.contextItemId = itemId;
  const title = fieldOf(paper, "title");
  if (title) resolved.title = title;
  const year = /\d{4}/.exec(fieldOf(paper, "date") || "")?.[0];
  if (year) resolved.year = year;
  const creator =
    typeof paper.firstCreator === "string" && paper.firstCreator.trim()
      ? paper.firstCreator.trim()
      : undefined;
  if (creator) resolved.creator = creator;
  if (typeof paper.key === "string" && paper.key) resolved.itemKey = paper.key;
  return { ok: true, paper: resolved };
}

/**
 * The `exclude` decisions a list of left-out papers states (submit_document's
 * and task_update's `excluded`), each with its reason. An id that names no
 * paper of the library is skipped: the list was already accepted as it is.
 */
export function exclusionPaperDecisions(
  exclusions: ReadonlyArray<{ targetIds: readonly string[]; reason: string }>,
  libraryID: number | undefined,
  lookup: PaperDecisionLookup | undefined,
): TaskPaperDecisionInput[] {
  const library = Math.floor(Number(libraryID));
  if (!lookup || !(library > 0)) return [];
  const decisions: TaskPaperDecisionInput[] = [];
  for (const exclusion of exclusions) {
    const reason = String(exclusion.reason || "").trim();
    if (!reason) continue;
    for (const target of exclusion.targetIds) {
      const itemId = paperDecisionTargetId(target);
      if (!itemId) continue;
      const resolved = resolveDecisionPaper(itemId, library, lookup);
      if (!resolved.ok) continue;
      decisions.push({ paper: resolved.paper, value: "exclude", reason });
    }
  }
  return decisions;
}

type DecisionRow =
  | {
      row: number;
      target: string;
      itemId: number;
      decision: Omit<TaskPaperDecisionInput, "paper">;
    }
  | { row: number; target: string; error: string };

type RecordPaperDecisionsInput = { rows: DecisionRow[] };

type Rejection = { row: number; target: string; reason: string };

type RecordPaperDecisionsResult = {
  ok: boolean;
  /** Papers whose decision this call recorded. */
  recorded: number;
  decisions?: Record<TaskPaperDecision["value"], number>;
  rejected?: Rejection[];
  /** Refused rows beyond the listed ones. */
  moreRejected?: number;
  error?: string;
};

function parseRow(value: unknown, row: number): DecisionRow {
  if (!validateObject<Record<string, unknown>>(value)) {
    return { row, target: "", error: "Each row must be an object." };
  }
  const target =
    typeof value.target === "number"
      ? String(value.target)
      : typeof value.target === "string"
        ? value.target.trim()
        : "";
  const itemId = paperDecisionTargetId(target);
  if (!itemId) {
    return {
      row,
      target,
      error: "target must be a Zotero item id (12 or item:12).",
    };
  }
  const decision = value.decision;
  if (!DECISIONS.includes(decision as TaskPaperDecision["value"])) {
    return {
      row,
      target,
      error: "decision must be include, exclude or defer.",
    };
  }
  const reason = typeof value.reason === "string" ? value.reason.trim() : "";
  if (!reason) return { row, target, error: "reason is required." };
  const relevance = value.relevance;
  if (
    relevance !== undefined &&
    !RELEVANCE.includes(
      relevance as NonNullable<TaskPaperDecision["relevance"]>,
    )
  ) {
    return {
      row,
      target,
      error: "relevance must be high, medium, low or none.",
    };
  }
  const subquestions = Array.isArray(value.subquestions)
    ? value.subquestions.filter(
        (label): label is string => typeof label === "string",
      )
    : undefined;
  return {
    row,
    target,
    itemId,
    decision: {
      value: decision as TaskPaperDecision["value"],
      reason,
      ...(relevance
        ? { relevance: relevance as TaskPaperDecision["relevance"] }
        : {}),
      ...(subquestions?.length ? { subquestions } : {}),
    },
  };
}

function validateRecordPaperDecisionsInput(
  args: unknown,
): AgentToolInputValidation<RecordPaperDecisionsInput> {
  if (!validateObject<Record<string, unknown>>(args)) {
    return fail(`${RECORD_PAPER_DECISIONS_TOOL_NAME} expects an object input`);
  }
  if (!Array.isArray(args.decisions) || !args.decisions.length) {
    return fail("decisions must be a non-empty array");
  }
  if (args.decisions.length > RECORD_PAPER_DECISIONS_MAX_ROWS) {
    return fail(
      `decisions takes at most ${RECORD_PAPER_DECISIONS_MAX_ROWS} rows; send the rest in another call`,
    );
  }
  return ok({
    rows: args.decisions.map((row, index) => parseRow(row, index + 1)),
  });
}

function executeRecordPaperDecisions(
  input: RecordPaperDecisionsInput,
  request: { conversationKey?: number; libraryID?: number },
  lookup: PaperDecisionLookup,
): {
  content: RecordPaperDecisionsResult;
  paperDecisions?: TaskPaperDecisionInput[];
} {
  const conversationKey = Math.floor(Number(request.conversationKey));
  if (!(conversationKey > 0)) {
    return { content: { ok: false, recorded: 0, error: NO_CONVERSATION } };
  }
  const libraryID = Math.floor(Number(request.libraryID));
  if (!(libraryID > 0)) {
    return { content: { ok: false, recorded: 0, error: NO_LIBRARY } };
  }
  const rejected: Rejection[] = [];
  // A paper named twice keeps its last row, as the ledger delta does.
  const byPaper = new Map<number, TaskPaperDecisionInput>();
  for (const row of input.rows) {
    if ("error" in row) {
      rejected.push({ row: row.row, target: row.target, reason: row.error });
      continue;
    }
    const resolved = resolveDecisionPaper(row.itemId, libraryID, lookup);
    if (!resolved.ok) {
      rejected.push({
        row: row.row,
        target: row.target,
        reason: resolved.reason,
      });
      continue;
    }
    byPaper.delete(resolved.paper.itemId);
    byPaper.set(resolved.paper.itemId, {
      ...row.decision,
      paper: resolved.paper,
    });
  }
  const paperDecisions = [...byPaper.values()];
  const counts: Record<TaskPaperDecision["value"], number> = {
    include: 0,
    exclude: 0,
    defer: 0,
  };
  for (const decision of paperDecisions) counts[decision.value] += 1;
  const content: RecordPaperDecisionsResult = {
    ok: paperDecisions.length > 0,
    recorded: paperDecisions.length,
    ...(paperDecisions.length ? { decisions: counts } : {}),
    ...(rejected.length
      ? { rejected: rejected.slice(0, MAX_LISTED_REJECTIONS) }
      : {}),
    ...(rejected.length > MAX_LISTED_REJECTIONS
      ? { moreRejected: rejected.length - MAX_LISTED_REJECTIONS }
      : {}),
  };
  return paperDecisions.length ? { content, paperDecisions } : { content };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function createRecordPaperDecisionsTool(
  lookup: PaperDecisionLookup,
): AgentToolDefinition<RecordPaperDecisionsInput, RecordPaperDecisionsResult> {
  return {
    spec: {
      name: RECORD_PAPER_DECISIONS_TOOL_NAME,
      description:
        "Record whether the task includes, excludes or defers each paper, with a one-sentence reason (up to 200 per call). Decisions are your judgment, kept apart from reads; a later call replaces a paper's decision.",
      inputSchema: {
        type: "object",
        additionalProperties: false,
        required: ["decisions"],
        properties: {
          decisions: {
            type: "array",
            items: {
              type: "object",
              additionalProperties: false,
              required: ["target", "decision", "reason"],
              properties: {
                target: {
                  type: "string",
                  description: "Zotero item id (12 or item:12).",
                },
                decision: { type: "string", enum: [...DECISIONS] },
                relevance: { type: "string", enum: [...RELEVANCE] },
                subquestions: { type: "array", items: { type: "string" } },
                reason: { type: "string" },
              },
            },
          },
        },
      },
      executionClass: "control",
      workCategory: "planning",
    },
    validate: validateRecordPaperDecisionsInput,
    planInvocation: () =>
      readOnlyInvocationPlan({
        domains: [],
        reason:
          "Record the agent's decisions about papers for the task (plugin state only).",
      }),
    execute: async (input, context) =>
      executeRecordPaperDecisions(input, context.request, lookup),
    presentation: {
      label: "Record Paper Decisions",
      summaries: {
        onCall: "Recording paper decisions",
        onSuccess: ({ content }) => {
          const result = record(content);
          const recorded = Number(result.recorded) || 0;
          if (!recorded) return "No paper decisions recorded";
          return recorded === 1
            ? "Recorded 1 paper decision"
            : `Recorded ${recorded} paper decisions`;
        },
      },
    },
  };
}
