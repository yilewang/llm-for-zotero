import type {
  ActionCardEffect,
  ActionCardEntry,
  ActionCardObject,
  ActionCardTarget,
  AgentActionSummaryResultCard,
  AgentNoteChangeResultCard,
  AgentRunEventRecord,
  AgentSavedNoteResultCard,
} from "../../../agent/types";
import type { AgentActionReceipt } from "../../../agent/contracts/types";
import { receiptReportsEffect } from "../../../agent/contracts/actionEvaluation";
import {
  AGENT_ACTION_VERIFICATION_LABELS,
  worstAgentActionVerification,
  type AgentActionVerification,
} from "../../../agent/contracts/actionVerificationLabels";
import { receiptOperationLabel } from "../../../agent/contracts/operationCatalog";
import { operationVerb } from "./actionCardVocabulary";
import { noteChangeCardHeader } from "./noteChangeCard";

// The card's row shapes are declared beside the card type in `agent/types`, so
// the runtime layer can state what a turn did without depending on the panel.
// They are re-exported here because this module is where they are built.
export type {
  ActionCardTarget,
  ActionCardObject,
  ActionCardEffect,
  ActionCardEntry,
} from "../../../agent/types";

/**
 * How the card names native objects.
 *
 * A receipt carries identities, not words. These resolve an identity against
 * the library the reader is looking at; a resolver that knows nothing returns
 * nothing, and the card falls back to the identity itself rather than inventing
 * a name.
 */
export type ActionCardResolvers = {
  /**
   * What the card should call this item, and — when the library answers with
   * a different item than the one asked about, as a note answers with the
   * paper it hangs under — which item that is.
   */
  itemLabel: (itemId: number) =>
    | (Omit<Extract<ActionCardTarget, { kind: "item" }>, "kind" | "itemId"> & {
        itemId?: number;
      })
    | undefined;
  collectionLabel: (
    collectionId: number,
  ) => { label: string; libraryID?: number } | undefined;
  noteLabel: (
    noteId: number,
  ) => { label: string; libraryID?: number; itemKey?: string } | undefined;
  materialTitle: (documentId: string) => string | undefined;
};

/** The wording a connected client's authority carries wherever it is shown. */
const EXTERNAL_AUTHORITY_LABEL = "Authorized by connected client";

/** The operations whose object is the note they wrote. */
const NOTE_OPERATIONS = new Set([
  "note_create",
  "note_edit",
  "note_append",
  "save_note",
  "save_notes_batch",
]);

/** Every receipt the run journaled, in the order the trace carries them. */
function collectRunReceipts(
  events: readonly AgentRunEventRecord[],
): AgentActionReceipt[] {
  const byId = new Map<string, AgentActionReceipt>();
  for (const entry of events) {
    const payload = entry.payload;
    const receipts =
      payload.type === "tool_result" || payload.type === "codex_tool_activity"
        ? payload.actionReceipts
        : undefined;
    for (const receipt of receipts || []) {
      // One effect reaches the trace through both the tool result and the
      // connected runtime's activity event; the receipt id is its identity.
      if (receipt?.id && !byId.has(receipt.id)) byId.set(receipt.id, receipt);
    }
  }
  return [...byId.values()];
}

/** Read source already recorded in the trace, without turning it into a receipt. */
function commandText(value: unknown): string | undefined {
  if (!value || typeof value !== "object") return undefined;
  const command = (value as Record<string, unknown>).command;
  return typeof command === "string" && command.trim() ? command : undefined;
}

function commandsByReceipt(
  events: readonly AgentRunEventRecord[],
): Map<string, string> {
  const calls = new Map<string, string>();
  const activities = new Map<string, string>();
  for (const { payload } of events) {
    if (payload.type === "tool_call") {
      const command = commandText(payload.args);
      if (command) calls.set(payload.callId, command);
    } else if (payload.type === "codex_tool_activity") {
      const command = payload.codeBlock || commandText(payload.args);
      if (command) activities.set(payload.itemId, command);
    }
  }
  const commands = new Map<string, string>();
  // Prefer the tool's executed result over an activity's copy of its request.
  const executed = new Map<string, string>();
  for (const { payload } of events) {
    if (
      payload.type !== "tool_result" &&
      payload.type !== "codex_tool_activity"
    )
      continue;
    const resultCommand =
      payload.type === "tool_result" ? commandText(payload.content) : undefined;
    const command =
      resultCommand ||
      (payload.type === "tool_result"
        ? calls.get(payload.callId)
        : activities.get(payload.itemId));
    if (!command) continue;
    for (const receipt of payload.actionReceipts || []) {
      if (receipt.operation !== "command_execute") continue;
      commands.set(receipt.id, command);
      if (resultCommand) executed.set(receipt.id, resultCommand);
    }
  }
  return new Map([...commands, ...executed]);
}

/** The material the run's visible answer was rendered from, when it named one. */
function answerMaterialTitle(
  events: readonly AgentRunEventRecord[],
  materialTitle: (documentId: string) => string | undefined,
): string | undefined {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const payload = events[index]?.payload;
    if (payload?.type !== "final") continue;
    const documentId = payload.materialRef?.documentId;
    return documentId ? materialTitle(documentId) : undefined;
  }
  return undefined;
}

/** The native item a `item:<id>` target names, when that is what it names. */
function itemIdOf(target: string): number | undefined {
  const match = /^item:(\d+)$/u.exec(target);
  return match ? Number(match[1]) : undefined;
}

/**
 * The note a note-writing receipt landed on.
 *
 * The verified fact is preferred because it is what the read-back actually
 * proved; the requested parameter is only what the action asked for, and a
 * create has none of it at all.
 */
export function noteEffectNoteId(
  receipt: AgentActionReceipt,
): number | undefined {
  for (const fact of receipt.verifiedFacts || []) {
    const match = /^native_note:(\d+):/u.exec(fact);
    if (match) return Number(match[1]);
  }
  const id = receipt.normalizedParameters?.targetNoteId;
  return typeof id === "number" && id > 0 ? id : undefined;
}

/** One target the card names as a native item. */
type ActionCardItemTarget = Extract<ActionCardTarget, { kind: "item" }>;

/**
 * The items a receipt's targets name, in the order the receipt lists them.
 *
 * A target that names anything else is left out: the row states the objects it
 * can name, not a token the reader would have to decode.
 *
 * A note-writing receipt targets the note it wrote, and the note is already
 * the effect's own chip. The resolver answers such a target with the paper the
 * note hangs under, and the row covers that paper — which is also why the row
 * an edited child note lands on is the row its paper's other effects land on.
 * A note that hangs under nothing is answered with nothing, and the target is
 * dropped rather than drawn as a phantom paper beside the note it already is.
 * An id the library cannot see for any other reason keeps its identity.
 */
function resolveTargets(
  targets: readonly string[],
  resolvers: ActionCardResolvers,
  noteIds: ReadonlySet<number> = new Set(),
): ActionCardItemTarget[] {
  const out: ActionCardItemTarget[] = [];
  for (const target of targets) {
    const itemId = itemIdOf(target);
    if (itemId === undefined) continue;
    const resolved = resolvers.itemLabel(itemId);
    if (!resolved && noteIds.has(itemId)) continue;
    out.push({
      kind: "item",
      itemId: resolved?.itemId ?? itemId,
      label: resolved?.label || `Item ${itemId}`,
      ...(resolved?.libraryID !== undefined
        ? { libraryID: resolved.libraryID }
        : {}),
      ...(resolved?.itemKey ? { itemKey: resolved.itemKey } : {}),
    });
  }
  return out;
}

/** The notes a receipt claims it wrote, which its targets may also name. */
function noteObjectIds(receipt: AgentActionReceipt): Set<number> {
  if (!NOTE_OPERATIONS.has(receipt.operation as string)) return new Set();
  const noteId = noteEffectNoteId(receipt);
  return new Set(noteId === undefined ? [] : [noteId]);
}

/**
 * What the effect acted on, beyond the items it covered: the collection it
 * moved into, the tags it applied, the note it wrote, the file it produced.
 *
 * Only the receipt's own normalized parameters and verified facts are read, so
 * the card can never name an object no receipt claims.
 */
function objectsOf(
  receipt: AgentActionReceipt,
  resolvers: ActionCardResolvers,
  targets: readonly ActionCardItemTarget[],
): ActionCardObject[] {
  const p = receipt.normalizedParameters || {};
  const op = receipt.operation as string;
  const collection = (
    id: number | undefined,
    name: string | undefined,
  ): ActionCardObject | null => {
    if (typeof id === "number") {
      const resolved = resolvers.collectionLabel(id);
      return {
        kind: "collection",
        label: resolved?.label || name || `Collection ${id}`,
        collectionId: id,
        ...(resolved?.libraryID !== undefined
          ? { libraryID: resolved.libraryID }
          : {}),
      };
    }
    return name ? { kind: "collection", label: name } : null;
  };
  if (
    op === "move_to_collection" ||
    op === "remove_from_collection" ||
    op === "set_item_collections" ||
    op === "create_collection" ||
    op === "update_collection" ||
    op === "delete_collection"
  ) {
    const single = collection(
      p.destinationCollectionId ?? p.collectionId,
      p.collectionName,
    );
    if (single) return [single];
    return (p.collectionIds || [])
      .map((id) => collection(id, undefined))
      .filter((entry): entry is ActionCardObject => Boolean(entry));
  }
  if (op === "apply_tags" || op === "set_item_tags")
    return (p.tags || []).map((label) => ({ kind: "tag", label }));
  if (op === "remove_tags")
    return (p.tags || []).map((label) => ({
      kind: "tag",
      label,
      removed: true as const,
    }));
  if (op === "update_library_tag")
    return [
      ...(p.tag
        ? [{ kind: "tag" as const, label: p.tag, removed: true as const }]
        : []),
      ...(p.newTag ? [{ kind: "tag" as const, label: p.newTag }] : []),
    ];
  if (NOTE_OPERATIONS.has(op)) {
    const noteId = noteEffectNoteId(receipt);
    const resolved =
      noteId !== undefined ? resolvers.noteLabel(noteId) : undefined;
    return [
      {
        kind: "note",
        label: resolved?.label || "Note",
        ...(noteId !== undefined ? { noteId } : {}),
        ...(resolved?.libraryID !== undefined
          ? { libraryID: resolved.libraryID }
          : {}),
        ...(resolved?.itemKey ? { itemKey: resolved.itemKey } : {}),
      },
    ];
  }
  if (
    op === "file_write" ||
    op === "rename_attachment" ||
    op === "relink_attachment" ||
    op === "import_local_files"
  ) {
    const path = p.newPath || p.newName;
    return path ? [{ kind: "file", label: path, path }] : [];
  }
  if (op === "command_execute" || op === "zotero_script_execute")
    return p.expectedText ? [{ kind: "command", label: p.expectedText }] : [];
  if (op === "update_metadata")
    return (p.metadataFields || []).map((label) => ({ kind: "field", label }));
  if (op === "trash_items" || op === "restore_from_trash") {
    // The trash is per library, so the chip opens the one the items it moved
    // actually live in; a receipt that named no library leaves the chip to
    // fall back to the reader's own.
    const libraryID = targets.find(
      (target) => target.libraryID !== undefined,
    )?.libraryID;
    return [
      { kind: "trash", ...(libraryID !== undefined ? { libraryID } : {}) },
    ];
  }
  return [];
}

/** The targets a receipt claims it covered, rejections excluded. */
function coveredTargets(receipt: AgentActionReceipt): string[] {
  const rejected = new Set(receipt.rejectedTargets || []);
  const covered = receipt.requestedTargets?.length
    ? receipt.requestedTargets.filter((target) => !rejected.has(target))
    : [
        ...(receipt.appliedTargets || []),
        ...(receipt.alreadySatisfiedTargets || []),
      ];
  return [...new Set(covered)];
}

/** One row under construction: its objects, and the receipts that filled it. */
type ActionCardRow = {
  targets: ActionCardItemTarget[];
  effects: ActionCardEffect[];
  receipts: AgentActionReceipt[];
  rejected: ActionCardItemTarget[];
  rejectedReason?: string;
};

/**
 * The verdict wording a row shows: what its receipts proved, and the authority
 * they ran under. The weakest proof wins, because a verified receipt beside an
 * unverified one does not make the row verified.
 */
function rowBadges(
  verification: AgentActionVerification | null,
  authority: boolean,
): string[] {
  return [
    verification ? AGENT_ACTION_VERIFICATION_LABELS[verification] : "",
    authority ? EXTERNAL_AUTHORITY_LABEL : "",
  ].filter(Boolean);
}

/**
 * What the turn did, projected from the receipts the run journaled.
 *
 * The reader used to get this as the `[Action status: …]` block appended to
 * the answer, which was written for the model. The same facts are stated here
 * instead, as structure rather than prose: the items an effect covered, the
 * operation's catalog label and glyph, the objects it acted on, and the shared
 * verification wording the trace rows already use. Nothing is read from a tool
 * name, and nothing is added that no receipt claims.
 *
 * Which receipts count is `receiptReportsEffect`, the same predicate the
 * model-facing block selects with, so the card and the block can never come to
 * disagree about what the turn did. A turn that only read and answered states
 * nothing and shows no card.
 *
 * Receipts that covered the same set of items share a row, keyed by those item
 * ids rather than by their labels, so two items that happen to read the same
 * never collapse into one. A receipt that named no item, and a receipt that
 * rejected a target, each keep a row of their own: the first shares no object
 * with anything, and the second owns a rejection that must not be attached to
 * effects that never hit it.
 *
 * The resolvers name native objects; a resolver that returns nothing leaves the
 * card with the identity it already had, never with a guess.
 */
export function buildAgentActionSummaryCard(
  events: readonly AgentRunEventRecord[],
  resolvers: ActionCardResolvers,
): AgentActionSummaryResultCard | null {
  const receipts = collectRunReceipts(events).filter(receiptReportsEffect);
  if (!receipts.length) return null;
  const commands = commandsByReceipt(events);
  const rows = new Map<string, ActionCardRow>();
  for (const receipt of receipts) {
    const noteIds = noteObjectIds(receipt);
    const targets = resolveTargets(coveredTargets(receipt), resolvers, noteIds);
    const rejected = resolveTargets(
      receipt.rejectedTargets || [],
      resolvers,
      noteIds,
    );
    const effect: ActionCardEffect = {
      receiptId: receipt.id,
      operation: receipt.operation,
      verb: operationVerb(receipt.operation),
      label: receiptOperationLabel(receipt),
      objects: objectsOf(receipt, resolvers, targets),
      ...(commands.has(receipt.id)
        ? { command: commands.get(receipt.id) }
        : {}),
    };
    const targetKey = [...new Set(targets.map((target) => target.itemId))]
      .sort((left, right) => left - right)
      .join(",");
    // A row states one verdict for the objects it lists, so only receipts that
    // named the same objects may share it. A receipt that named none has
    // nothing to share — a verified file write must not inherit a command's
    // "no state proof" — and a receipt that rejected a target owns its reason.
    // Both keep a row of their own.
    const key = targetKey && !rejected.length ? targetKey : `#${receipt.id}`;
    const existing = rows.get(key);
    if (existing) {
      existing.effects.push(effect);
      existing.receipts.push(receipt);
      continue;
    }
    rows.set(key, {
      targets,
      effects: [effect],
      receipts: [receipt],
      rejected,
      ...(rejected.length && receipt.reasons?.[0]
        ? { rejectedReason: receipt.reasons[0] }
        : {}),
    });
  }
  const entries: ActionCardEntry[] = [...rows.values()].map((row) => {
    const verification = worstAgentActionVerification(row.receipts);
    const authority = row.receipts.some(
      (receipt) => receipt.executionAuthority === "external_runtime",
    );
    // A partial receipt landed some of what it asked for and not the rest,
    // whether or not it named the targets it left out. The row says so even
    // when it has no rejection to list, so the pill is never read as "all of
    // this happened".
    const partial = row.receipts.some(
      (receipt) => receipt.status === "partial",
    );
    return {
      targets: row.targets,
      effects: row.effects,
      verification,
      badges: rowBadges(verification, authority),
      ...(authority ? { authority: "external_runtime" as const } : {}),
      rejected: row.rejected,
      ...(row.rejectedReason ? { rejectedReason: row.rejectedReason } : {}),
      ...(partial ? { partial: true as const } : {}),
    };
  });
  return {
    kind: "action_summary",
    answerMaterial: answerMaterialTitle(events, resolvers.materialTitle),
    actionCount: receipts.length,
    entries,
  };
}

/** A note card the turn produced, whichever of the two kinds it is. */
type NoteResultCard = AgentSavedNoteResultCard | AgentNoteChangeResultCard;

/** The detail a row opens for the note card that matched it. */
function noteDetail(
  card: NoteResultCard,
): NonNullable<ActionCardEntry["detail"]> {
  return card.kind === "note_change"
    ? { kind: "note_change", card }
    : { kind: "saved_note", card };
}

/** Whether a row's effects wrote a note at all. */
function writesNote(entry: ActionCardEntry): boolean {
  return entry.effects.some((effect) =>
    effect.objects.some((object) => object.kind === "note"),
  );
}

/** The notes a row's effects claim they landed on, in the row's own order. */
function noteIdsOf(entry: ActionCardEntry): number[] {
  return entry.effects.flatMap((effect) =>
    effect.objects.flatMap((object) =>
      object.kind === "note" && object.noteId !== undefined
        ? [object.noteId]
        : [],
    ),
  );
}

/**
 * Give each row the note card that belongs to it, and say which cards are left.
 *
 * A note card and an action row are two statements about the same write, so the
 * reader must be shown one of them, not both. The receipt's own note id is what
 * pairs them. A note write that could not read the note back leaves the row
 * without an id; when that row and one card are all that is left unmatched,
 * they are the same write and are paired anyway. Anything still unmatched is a
 * note no receipt claims, and it keeps its own card.
 *
 * Known limits, both of which err towards showing the reader a card rather than
 * hiding one: a row that names two notes claims only the first card that
 * matches it, and the second note keeps its own card below; and the pairing of
 * last resort counts rows, not receipts, so a single row built from two
 * note-writing receipts is one candidate for it.
 */
export function attachNoteDetails(
  card: AgentActionSummaryResultCard,
  noteCards: readonly NoteResultCard[],
): { card: AgentActionSummaryResultCard; unmatched: NoteResultCard[] } {
  const unmatched = [...noteCards];
  const claim = (noteId: number): NoteResultCard | undefined => {
    const index = unmatched.findIndex(
      (candidate) => candidate.note.itemId === noteId,
    );
    return index < 0 ? undefined : unmatched.splice(index, 1)[0];
  };
  const entries = card.entries.map((entry) => {
    for (const noteId of noteIdsOf(entry)) {
      const matched = claim(noteId);
      if (matched) return { ...entry, detail: noteDetail(matched) };
    }
    return entry;
  });
  const orphanRows = entries.flatMap((entry, index) =>
    !entry.detail && writesNote(entry) ? [index] : [],
  );
  if (orphanRows.length === 1 && unmatched.length === 1) {
    const index = orphanRows[0];
    entries[index] = { ...entries[index], detail: noteDetail(unmatched[0]) };
    unmatched.length = 0;
  }
  return { card: { ...card, entries }, unmatched };
}

/**
 * The header a card wears when the note is the whole turn, or null when it is
 * not.
 *
 * One receipt that wrote one note is the note card the reader used to get; it
 * is now the same card, so it says what that card said and opens its row.
 */
export function actionCardNoteMode(card: AgentActionSummaryResultCard): {
  title: string;
  status: string;
  statusKind: string;
  extraClass: string;
} | null {
  const detail =
    card.actionCount === 1 && card.entries.length === 1
      ? card.entries[0].detail
      : undefined;
  if (!detail) return null;
  return detail.kind === "note_change"
    ? {
        ...noteChangeCardHeader(detail.card),
        extraClass: "llm-note-change-card",
      }
    : {
        title: detail.card.title,
        status: "Saved",
        statusKind: "completed",
        extraClass: "llm-saved-note-card",
      };
}
